package hik;

import java.io.BufferedReader;
import java.io.InputStreamReader;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.StandardCopyOption;
import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.TimeUnit;
import java.util.function.DoubleConsumer;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * ffmpeg 调用封装（用 ProcessBuilder 起子进程）
 *
 * 要点：
 *  - ffmpeg 是独立进程，必须在工作线程里跑，不能阻塞请求线程
 *  - 部署环境要单独装 ffmpeg，或用 FFMPEG_PATH 环境变量指定绝对路径
 *  - 从 stderr 解析 time= 可以拿到已处理时长，用来做进度
 */
public class FfmpegRunner {

    private static final String FFMPEG =
            System.getenv().getOrDefault("FFMPEG_PATH", "ffmpeg");

    private static final Pattern TIME =
            Pattern.compile("time=(\\d+):(\\d+):(\\d+(?:\\.\\d+)?)");

    /** 海康 PS 流 -> mp4：先无损封装，不行再降级 */
    public static boolean toMp4(Path in, Path out) {
        List<List<String>> attempts = List.of(
                List.of("-c", "copy", "-tag:v", "hvc1"),
                List.of("-c:v", "copy", "-c:a", "aac"),
                List.of("-c:v", "libx264", "-preset", "veryfast", "-crf", "23", "-c:a", "aac")
        );
        for (List<String> extra : attempts) {
            List<String> cmd = new ArrayList<>(List.of(
                    FFMPEG, "-hide_banner", "-loglevel", "error", "-y", "-i", in.toString()));
            cmd.addAll(extra);
            cmd.add(out.toString());
            if (run(cmd, null) == 0 && exists(out)) return true;
        }
        return false;
    }

    /** 多段合并成一条视频 */
    public static boolean concat(List<Path> parts, Path out) {
        if (parts.isEmpty()) return false;

        if (parts.size() == 1) {
            try {
                Files.copy(parts.get(0), out, StandardCopyOption.REPLACE_EXISTING);
                return exists(out);
            } catch (Exception e) {
                return false;
            }
        }

        Path list = out.resolveSibling(out.getFileName() + ".txt");
        try {
            StringBuilder sb = new StringBuilder();
            for (Path p : parts) {
                sb.append("file '")
                  .append(p.toAbsolutePath().toString().replace('\\', '/'))
                  .append("'\n");
            }
            Files.writeString(list, sb.toString(), StandardCharsets.UTF_8);
        } catch (Exception e) {
            return false;
        }

        int code = run(List.of(FFMPEG, "-hide_banner", "-loglevel", "error", "-y",
                "-f", "concat", "-safe", "0", "-i", list.toString(),
                "-c", "copy", out.toString()), null);

        try { Files.deleteIfExists(list); } catch (Exception ignored) { }

        return code == 0 && exists(out);
    }

    /**
     * 直接拉 RTSP 回放流存文件 —— 不走 ISAPI，一条命令搞定。
     * onSeconds 回调收到的是已处理的秒数（用于进度展示）。
     */
    public static boolean pullRtsp(String rtspUrl, Path out, DoubleConsumer onSeconds) {
        int code = run(List.of(FFMPEG, "-hide_banner", "-loglevel", "info", "-y",
                "-rtsp_transport", "tcp", "-i", rtspUrl,
                "-c", "copy", "-tag:v", "hvc1", out.toString()), onSeconds);
        return code == 0 && exists(out);
    }

    /** 探测 ffmpeg 是否可用 */
    public static boolean available() {
        return run(List.of(FFMPEG, "-version"), null) == 0;
    }

    private static int run(List<String> cmd, DoubleConsumer onSeconds) {
        Process p = null;
        try {
            p = new ProcessBuilder(cmd).redirectErrorStream(true).start();

            try (BufferedReader r = new BufferedReader(
                    new InputStreamReader(p.getInputStream(), StandardCharsets.UTF_8))) {
                String line;
                while ((line = r.readLine()) != null) {
                    if (onSeconds != null) {
                        Matcher m = TIME.matcher(line);
                        if (m.find()) {
                            double sec = Integer.parseInt(m.group(1)) * 3600
                                    + Integer.parseInt(m.group(2)) * 60
                                    + Double.parseDouble(m.group(3));
                            onSeconds.accept(sec);
                        }
                    }
                }
            }

            if (!p.waitFor(30, TimeUnit.MINUTES)) {
                p.destroyForcibly();
                return -1;
            }
            return p.exitValue();
        } catch (Exception e) {
            if (p != null) p.destroyForcibly();
            return -1;
        }
    }

    private static boolean exists(Path p) {
        try {
            return Files.exists(p) && Files.size(p) > 0;
        } catch (Exception e) {
            return false;
        }
    }
}
