package hik;

import java.io.IOException;
import java.io.InputStream;
import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.security.MessageDigest;
import java.security.SecureRandom;
import java.time.Duration;
import java.time.ZoneId;
import java.time.ZonedDateTime;
import java.time.format.DateTimeFormatter;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * 海康 ISAPI 客户端（零依赖，JDK 15+）
 *
 * 关键点：JDK 自带的 HttpClient 只支持 Basic 认证，不支持 Digest。
 * 所以这里手写了 Digest 握手：先发一次拿 401 + WWW-Authenticate，
 * 算出 response 摘要后带 Authorization 重发。
 *
 * 用法：
 *   var c = new HikIsapiClient("192.168.1.64", 80, "admin", "密码");
 *   var segs = c.search(101, startZoned, endZoned);   // 101 = 通道1主码流
 *   c.download(segs.get(0).uri(), Path.of("out.ps"));
 */
public class HikIsapiClient {

    public record Segment(String start, String end, String uri) {}

    private static final DateTimeFormatter ISAPI_FMT =
            DateTimeFormatter.ofPattern("yyyy-MM-dd'T'HH:mm:ss'Z'");
    private static final ZoneId UTC = ZoneId.of("UTC");
    private static final SecureRandom RND = new SecureRandom();

    private final String base;
    private final String user;
    private final String password;
    private final HttpClient http;

    public HikIsapiClient(String host, int port, String user, String password) {
        this.base = "http://" + host + ":" + port;
        this.user = user;
        this.password = password;
        this.http = HttpClient.newBuilder()
                .connectTimeout(Duration.ofSeconds(10))
                .followRedirects(HttpClient.Redirect.NEVER)
                .build();
    }

    /** 搜索录像段。track：通道N主码流 = N*100+1，子码流 = N*100+2 */
    public List<Segment> search(int track, ZonedDateTime start, ZonedDateTime end) throws Exception {
        List<Segment> out = new ArrayList<>();
        String sid = UUID.randomUUID().toString().replace("-", "").toUpperCase();
        int pos = 0;

        while (true) {
            String body = """
                    <?xml version="1.0" encoding="utf-8"?>
                    <CMSearchDescription>
                      <searchID>%s</searchID>
                      <trackList><trackID>%d</trackID></trackList>
                      <timeSpanList><timeSpan>
                        <startTime>%s</startTime>
                        <endTime>%s</endTime>
                      </timeSpan></timeSpanList>
                      <maxResults>100</maxResults>
                      <searchResultPostion>%d</searchResultPostion>
                      <metadataList>
                        <metadataDescriptor>//recordType.meta.std-cgi.com</metadataDescriptor>
                      </metadataList>
                    </CMSearchDescription>
                    """.formatted(sid, track,
                    ISAPI_FMT.format(start.withZoneSameInstant(UTC)),
                    ISAPI_FMT.format(end.withZoneSameInstant(UTC)),
                    pos);

            String xml = post("/ISAPI/ContentMgmt/search", body);
            String status = tag(xml, "responseStatusStrg");
            List<String> items = blocks(xml, "searchMatchItem");

            for (String it : items) {
                String uri = unescape(tag(it, "playbackURI"));
                if (uri == null || uri.isBlank()) continue;
                List<String> ts = blocks(it, "timeSpan");
                String scope = ts.isEmpty() ? it : ts.get(0);
                out.add(new Segment(tag(scope, "startTime"), tag(scope, "endTime"), uri));
            }

            if (!"MORE".equalsIgnoreCase(status)) break;
            pos += Math.max(items.size(), 1);
        }
        return out;
    }

    /** 下载一段录像为海康私有 PS 流，返回字节数 */
    public long download(String playbackUri, Path out) throws Exception {
        String body = """
                <?xml version="1.0" encoding="utf-8"?>
                <downloadRequest><playbackURI>%s</playbackURI></downloadRequest>
                """.formatted(playbackUri.replace("&", "&amp;"));

        HttpResponse<InputStream> resp = request("POST", "/ISAPI/ContentMgmt/download", body);
        if (resp.statusCode() != 200) {
            String err;
            try (InputStream in = resp.body()) {
                err = new String(in.readAllBytes(), StandardCharsets.UTF_8);
            }
            throw new IOException("下载失败 HTTP " + resp.statusCode() + ": " + err);
        }

        long total = 0;
        try (InputStream in = resp.body(); var os = Files.newOutputStream(out)) {
            byte[] buf = new byte[256 * 1024];
            int n;
            while ((n = in.read(buf)) > 0) {
                os.write(buf, 0, n);
                total += n;
            }
        }
        return total;
    }

    private String post(String path, String body) throws Exception {
        HttpResponse<InputStream> r = request("POST", path, body);
        try (InputStream in = r.body()) {
            String xml = new String(in.readAllBytes(), StandardCharsets.UTF_8);
            if (r.statusCode() != 200) throw new IOException("HTTP " + r.statusCode() + ": " + xml);
            return xml;
        }
    }

    // ---------------------------------------------------------- Digest 核心

    private HttpResponse<InputStream> request(String method, String path, String body) throws Exception {
        URI uri = URI.create(base + path);
        HttpResponse<InputStream> resp = send(method, uri, path, body, null);

        if (resp.statusCode() == 401) {
            resp.body().close();
            String challenge = resp.headers().firstValue("WWW-Authenticate").orElse("");
            if (!challenge.toLowerCase().startsWith("digest")) {
                throw new IOException("设备要求非 Digest 认证，收到: " + challenge);
            }
            resp = send(method, uri, path, body, buildDigest(method, path, challenge));
        }
        return resp;
    }

    private HttpResponse<InputStream> send(String method, URI uri, String path,
                                           String body, String authorization) throws Exception {
        HttpRequest.BodyPublisher pub = (body == null)
                ? HttpRequest.BodyPublishers.noBody()
                : HttpRequest.BodyPublishers.ofString(body, StandardCharsets.UTF_8);

        HttpRequest.Builder b = HttpRequest.newBuilder(uri)
                .timeout(Duration.ofMinutes(30))
                .header("Content-Type", "application/xml");
        if (authorization != null) b.header("Authorization", authorization);
        b.method(method, pub);

        return http.send(b.build(), HttpResponse.BodyHandlers.ofInputStream());
    }

    private String buildDigest(String method, String uriPath, String challenge) throws Exception {
        Map<String, String> p = parseChallenge(challenge);
        String realm = p.get("realm");
        String nonce = p.get("nonce");
        String qop = p.getOrDefault("qop", "");
        if (qop.contains(",")) qop = qop.split(",")[0].trim();

        String nc = "00000001";
        String cnonce = randomHex(8);

        String ha1 = md5(user + ":" + realm + ":" + password);
        String ha2 = md5(method + ":" + uriPath);

        String response = qop.isEmpty()
                ? md5(ha1 + ":" + nonce + ":" + ha2)
                : md5(ha1 + ":" + nonce + ":" + nc + ":" + cnonce + ":" + qop + ":" + ha2);

        StringBuilder sb = new StringBuilder("Digest username=\"").append(user)
                .append("\", realm=\"").append(realm)
                .append("\", nonce=\"").append(nonce)
                .append("\", uri=\"").append(uriPath)
                .append("\", algorithm=MD5");
        if (!qop.isEmpty()) {
            sb.append(", qop=").append(qop)
              .append(", nc=").append(nc)
              .append(", cnonce=\"").append(cnonce).append("\"");
        }
        sb.append(", response=\"").append(response).append("\"");
        return sb.toString();
    }

    private static Map<String, String> parseChallenge(String challenge) {
        Map<String, String> map = new HashMap<>();
        String s = challenge.replaceFirst("(?i)^Digest\\s+", "");
        Matcher m = Pattern.compile("(\\w+)\\s*=\\s*\"([^\"]*)\"|(\\w+)\\s*=\\s*([^,\\s]+)").matcher(s);
        while (m.find()) {
            if (m.group(1) != null) map.put(m.group(1).toLowerCase(), m.group(2));
            else map.put(m.group(3).toLowerCase(), m.group(4));
        }
        return map;
    }

    private static String md5(String s) throws Exception {
        byte[] d = MessageDigest.getInstance("MD5").digest(s.getBytes(StandardCharsets.UTF_8));
        StringBuilder sb = new StringBuilder();
        for (byte b : d) sb.append(String.format("%02x", b));
        return sb.toString();
    }

    private static String randomHex(int n) {
        byte[] b = new byte[n];
        RND.nextBytes(b);
        StringBuilder sb = new StringBuilder();
        for (byte x : b) sb.append(String.format("%02x", x));
        return sb.toString();
    }

    // ---------------------------------------------------------- XML 小工具

    private static String tag(String xml, String name) {
        if (xml == null) return null;
        Matcher m = Pattern.compile("<" + name + "\\b[^>]*>(.*?)</" + name + ">", Pattern.DOTALL).matcher(xml);
        return m.find() ? m.group(1).trim() : null;
    }

    private static List<String> blocks(String xml, String name) {
        List<String> list = new ArrayList<>();
        if (xml == null) return list;
        Matcher m = Pattern.compile("<" + name + "\\b[^>]*>(.*?)</" + name + ">", Pattern.DOTALL).matcher(xml);
        while (m.find()) list.add(m.group(1));
        return list;
    }

    private static String unescape(String s) {
        if (s == null) return null;
        return s.replace("&lt;", "<").replace("&gt;", ">").replace("&quot;", "\"").replace("&amp;", "&");
    }
}
