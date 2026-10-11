import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { compressionPlan, compressVideo, ffmpegArgs, findVideoTools, pathWhich, probeDuration, type VideoTools } from '../src/lib/compress.js';
import { MAX_VIDEO_BYTES } from '../src/files.js';

describe('the bitrate that fits 100 MB', () => {
  it('aims at 90% of 100 MB over the duration, at most 8 Mbit/s, with 96 kbit/s of mono AAC', () => {
    // Ten minutes, the longest the API takes: about 1.26 Mbit/s, so 720p.
    expect(compressionPlan(600)).toEqual({ seconds: 600, totalBitrate: 1_258_291, videoBitrate: 1_162_291, audioBitrate: 96_000, longSide: 1280 });
    // 0.9 × 104,857,600 B × 8 / 302 s = 2,499,916 bit/s: just under 2.5 Mbit/s, still 720p.
    expect(compressionPlan(302)).toMatchObject({ totalBitrate: 2_499_916, longSide: 1280 });
    expect(compressionPlan(301)).toMatchObject({ totalBitrate: 2_508_221, longSide: 1920 });
    // A short clip: capped, a scan gains nothing above 8 Mbit/s.
    expect(compressionPlan(30)).toMatchObject({ totalBitrate: 8_000_000, videoBitrate: 7_904_000, longSide: 1920 });
    for (const seconds of [1, 19, 50, 120, 300, 599.9, 600]) {
      const plan = compressionPlan(seconds);
      expect((plan.totalBitrate * seconds) / 8, String(seconds)).toBeLessThanOrEqual(0.9 * MAX_VIDEO_BYTES);
    }
  });

  it('builds the ffmpeg command as an argument array: H.264 veryfast, the long side capped and never enlarged, AAC mono, faststart', () => {
    const args = ffmpegArgs('/videos/IMG 0042.MOV', '/tmp/x/video.mp4', compressionPlan(600));
    expect(args).toEqual([
      '-hide_banner',
      '-nostdin',
      '-y',
      '-i',
      '/videos/IMG 0042.MOV',
      '-map',
      '0:v:0',
      '-map',
      '0:a:0?',
      '-vf',
      "scale=w='trunc(min(1,1280/max(iw,ih))*iw/2)*2':h='trunc(min(1,1280/max(iw,ih))*ih/2)*2'",
      '-c:v',
      'libx264',
      '-preset',
      'veryfast',
      '-pix_fmt',
      'yuv420p',
      '-b:v',
      '1162291',
      '-maxrate',
      '1162291',
      '-bufsize',
      '2324582',
      '-c:a',
      'aac',
      '-b:a',
      '96000',
      '-ac',
      '1',
      '-movflags',
      '+faststart',
      '-progress',
      'pipe:1',
      '-nostats',
      '-loglevel',
      'error',
      '/tmp/x/video.mp4',
    ]);
  });

  it('reads the duration ffprobe prints, and says when it prints none', async () => {
    const tools: VideoTools = { ffmpeg: '/bin/ffmpeg', ffprobe: '/bin/ffprobe' };
    const answer = (output: string, code: number | null = 0) => async () => ({ code, output, timedOut: false, stopped: false });
    expect(await probeDuration(tools, 'in.mp4', answer('612.480000\n'))).toEqual({ seconds: 612.48 });
    expect(await probeDuration(tools, 'in.webm', answer('N/A\n'))).toEqual({ seconds: null, reason: 'the file does not say how long it lasts' });
    expect(await probeDuration(tools, 'in.mp4', answer('in.mp4: moov atom not found\n', 1))).toEqual({ seconds: null, reason: 'in.mp4: moov atom not found' });
  });
});

// The real thing, when ffmpeg is installed: a rotated phone video comes out upright, smaller, H.264 and AAC mono.
const realTools = await findVideoTools(pathWhich(process.env, process.platform));

describe.skipIf(!realTools)('with the real ffmpeg', () => {
  let directory: string;
  const tools = realTools!;
  const probe = (file: string) =>
    JSON.parse(
      execFileSync(tools.ffprobe, ['-v', 'error', '-show_entries', 'stream=codec_type,codec_name,width,height,channels,pix_fmt:stream_side_data=rotation', '-of', 'json', file], {
        encoding: 'utf8',
      })
    ) as { streams: Array<{ codec_type: string; codec_name: string; width?: number; height?: number; channels?: number; pix_fmt?: string; side_data_list?: Array<{ rotation?: number }> }> };

  beforeAll(async () => {
    directory = await mkdtemp(path.join(tmpdir(), 'spacecontext-ffmpeg-'));
  });
  afterAll(async () => {
    await rm(directory, { recursive: true, force: true });
  });

  it('turns a portrait phone video upright, caps its long side without ever enlarging, and writes an MP4 the API reads', { timeout: 60_000 }, async () => {
    // A landscape 1920×1080 recording with a 90° display rotation: what a phone held upright writes.
    const landscape = path.join(directory, 'landscape.mp4');
    execFileSync(tools.ffmpeg, [
      '-hide_banner', '-loglevel', 'error', '-y',
      '-f', 'lavfi', '-i', 'testsrc=size=1920x1080:rate=30:duration=2',
      '-f', 'lavfi', '-i', 'sine=frequency=440:duration=2:sample_rate=48000',
      '-ac', '2', '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', landscape,
    ]);
    const input = path.join(directory, 'IMG_0042.MOV');
    let rotated = true;
    try {
      execFileSync(tools.ffmpeg, ['-hide_banner', '-loglevel', 'error', '-y', '-display_rotation', '90', '-i', landscape, '-c', 'copy', input]);
    } catch {
      // An ffmpeg older than 6 cannot write the rotation: the rest is still checked.
      rotated = false;
      execFileSync(tools.ffmpeg, ['-hide_banner', '-loglevel', 'error', '-y', '-i', landscape, '-c', 'copy', input]);
    }

    const duration = await probeDuration(tools, input);
    expect(duration.seconds).toBeGreaterThan(1.9);
    // Ten minutes' worth of bitrate on two seconds: the 1280 cap applies.
    const plan = { ...compressionPlan(600), seconds: duration.seconds! };
    const output = path.join(directory, 'video.mp4');
    const progress: number[] = [];
    const bytes = await compressVideo({ tools, input, output, plan, onProgress: (fraction) => progress.push(fraction) });

    expect(bytes).toBeGreaterThan(0);
    expect(progress.at(-1)).toBeGreaterThan(0.9);
    const streams = probe(output).streams;
    const video = streams.find((stream) => stream.codec_type === 'video')!;
    const audio = streams.find((stream) => stream.codec_type === 'audio')!;
    expect(video).toMatchObject({ codec_name: 'h264', pix_fmt: 'yuv420p', ...(rotated ? { width: 720, height: 1280 } : { width: 1280, height: 720 }) });
    // Upright pixels and no rotation left for a player (or the API) to apply again.
    expect(video.side_data_list?.some((data) => data.rotation)).toBeFalsy();
    expect(audio).toMatchObject({ codec_name: 'aac', channels: 1 });
    // faststart: the index before the media data.
    const head = (await readFile(output)).subarray(0, 64 * 1024).toString('latin1');
    expect(head.indexOf('moov')).toBeGreaterThan(-1);
    expect(head.indexOf('moov')).toBeLessThan(head.indexOf('mdat'));

    // A small Matroska video keeps its size: never enlarged.
    const small = path.join(directory, 'small.mkv');
    execFileSync(tools.ffmpeg, ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc=size=640x360:rate=15:duration=1', '-c:v', 'libx264', '-preset', 'ultrafast', small]);
    const smallOutput = path.join(directory, 'small.mp4');
    await compressVideo({ tools, input: small, output: smallOutput, plan: { ...compressionPlan(60), seconds: 1 } });
    expect(probe(smallOutput).streams.find((stream) => stream.codec_type === 'video')).toMatchObject({ codec_name: 'h264', width: 640, height: 360 });
  });
});
