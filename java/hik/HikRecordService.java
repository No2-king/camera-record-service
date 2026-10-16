package hik;

import java.nio.file.Files;
import java.nio.file.Path;
import java.time.LocalDateTime;
import java.time.ZoneId;
import java.time.format.DateTimeFormatter;
import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.function.IntConsumer;

/**
 * 录像下载业务编排：搜索 -> 逐段下载 -> 转 mp4 -> 合并
 *
 * 在 Spring 里注册成 Bean 直接用：
 *
 *   @Bean
 *   public HikRecordService hikRecordService() throws IOException {
 *       Path dir = Path.of("D:/hik_records");
 *       Files.createDirectories(dir);
 *       return new HikRecordService("192.168.1.64", 80, "admin", "密码", dir, ZoneId.of("Asia/Shanghai"));
 *   }
 *
 * 注意：download() 是阻塞的，里面要等 ffmpeg 子进程跑完。
 * Spring MVC 的请求线程里直接调会占住线程池，所以用 downloadAsync()。
 */
public class HikRecordService {

    private final HikIsapiClient client;
    private final Path outDir;
    private final ZoneId zone;
    private final ExecutorService pool;

    public HikRecordService(String host, int port, String user, String password,
                            Path outDir, ZoneId zone) {
        this.client = new HikIsapiClient(host, port, user, password);
        this.outDir = outDir;
        this.zone = zone;
        this.pool = Executors.newFixedThreadPool(4);
    }

    public HikRecordService(String host, int port, String user, String password, Path outDir) {
        this(host, port, user, password, outDir, ZoneId.systemDefault());
    }

    /** 查询录像段。时间用本地时区，内部自动转 UTC */
    public List<HikIsapiClient.Segment> search(int channel, String stream,
                                               LocalDateTime start, LocalDateTime end) throws Exception {
        return client.search(track(channel, stream), start.atZone(zone), end.atZone(zone));
    }

    /**
     * 同步下载区间视频，返回成品 mp4 路径。
     * onProgress 收到 0-100，按已完成段数计算。
     */
    public Path download(int channel, String stream, LocalDateTime start, LocalDateTime end,
                         IntConsumer onProgress) throws Exception {

        List<HikIsapiClient.Segment> segs = search(channel, stream, start, end);
        if (segs.isEmpty()) {
            throw new IllegalStateException("该时间段没有录像（未配置录像计划 / 已被循环覆盖 / 时间写错）");
        }

        Files.createDirectories(outDir);
        Path work = Files.createTempDirectory(outDir, "hikjob_");
        List<Path> mp4s = new ArrayList<>();

        try {
            for (int i = 0; i < segs.size(); i++) {
                Path ps = work.resolve(String.format("%03d.ps", i));
                long n = client.download(segs.get(i).uri(), ps);

                if (n > 0) {
                    Path mp4 = work.resolve(String.format("%03d.mp4", i));
                    if (FfmpegRunner.toMp4(ps, mp4)) {
                        mp4s.add(mp4);
                    }
                }
                Files.deleteIfExists(ps);

                if (onProgress != null) {
                    onProgress.accept((i + 1) * 100 / segs.size());
                }
            }

            if (mp4s.isEmpty()) {
                throw new IllegalStateException("下载到的流为空，可能是该段录像不存在或已被覆盖");
            }

            String name = String.format("ch%d_%s_%s.mp4", channel,
                    start.format(DateTimeFormatter.ofPattern("yyyyMMdd_HHmmss")),
                    end.format(DateTimeFormatter.ofPattern("HHmmss")));

            Path finalFile = outDir.resolve(name);
            Files.deleteIfExists(finalFile);

            if (!FfmpegRunner.concat(mp4s, finalFile)) {
                throw new IllegalStateException("合并 mp4 失败");
            }
            return finalFile;

        } finally {
            // 清掉中间产物
            try (var s = Files.list(work)) {
                s.forEach(p -> { try { Files.deleteIfExists(p); } catch (Exception ignored) { } });
            } catch (Exception ignored) { }
            try { Files.deleteIfExists(work); } catch (Exception ignored) { }
        }
    }

    public Path download(int channel, String stream, LocalDateTime start, LocalDateTime end)
            throws Exception {
        return download(channel, stream, start, end, null);
    }

    /** 异步版：Spring 请求线程里用这个，别阻塞 */
    public CompletableFuture<Path> downloadAsync(int channel, String stream,
                                                 LocalDateTime start, LocalDateTime end,
                                                 IntConsumer onProgress) {
        return CompletableFuture.supplyAsync(() -> {
            try {
                return download(channel, stream, start, end, onProgress);
            } catch (Exception e) {
                throw new RuntimeException(e);
            }
        }, pool);
    }

    /** 通道号 + 码流 -> trackID。通道1主码流=101，子码流=102，通道2=201 */
    private static int track(int channel, String stream) {
        return channel * 100 + ("sub".equalsIgnoreCase(stream) ? 2 : 1);
    }

    public void shutdown() {
        pool.shutdown();
    }
}
