import { stat } from 'node:fs/promises';
import { findExecutable, runProgram, type Runner } from './system.js';

/**
 * A video re-encoded with ffmpeg, when it is installed: to fit when it is over
 * the API's limit (4 GB where the API reads videos with its own ffmpeg, 100 MB
 * on an older deployment), or to upload less on a slow connection
 * (`--compress`). A scan needs no more than 8 Mbit/s; under 100 MB, 10 minutes
 * fit only at about 1.4 Mbit/s, which H.264 at 720p holds well.
 */

export type VideoTools = { ffmpeg: string; ffprobe: string };

/** ffmpeg and ffprobe, both needed (the duration sets the bitrate); null when either is missing. */
export async function findVideoTools(which: (program: string) => Promise<string | null>): Promise<VideoTools | null> {
  const [ffmpeg, ffprobe] = await Promise.all([which('ffmpeg'), which('ffprobe')]);
  return ffmpeg && ffprobe ? { ffmpeg, ffprobe } : null;
}

/** `which` on the PATH of `env`. */
export function pathWhich(env: Record<string, string | undefined>, platform: NodeJS.Platform): (program: string) => Promise<string | null> {
  return (program) => findExecutable(program, env, platform);
}

/** Above this the picture would not get better for a scan, only bigger. */
export const MAX_TOTAL_BITRATE = 8_000_000;
export const AUDIO_BITRATE = 96_000;
/** Below this total bitrate the long side drops from 1920 to 1280: 1080p at 1.2 Mbps is blockier than 720p. */
export const SMALL_PICTURE_BELOW = 2_500_000;
/** Of the API's limit, what the bitrate aims at: the rest is the container and the encoder's overshoot. */
const SIZE_MARGIN = 0.9;

export type CompressionPlan = {
  /** The video's duration, for the progress. */
  seconds: number;
  /** Bits per second, audio included. */
  totalBitrate: number;
  videoBitrate: number;
  audioBitrate: number;
  /** The longest side of the picture, in pixels (never enlarged). */
  longSide: 1920 | 1280;
};

/** The bitrates that make `seconds` of video fit in `maxBytes` (the API's limit) with a 10% margin, at most 8 Mbit/s. */
export function compressionPlan(seconds: number, maxBytes: number): CompressionPlan {
  const totalBitrate = Math.min(MAX_TOTAL_BITRATE, Math.floor((SIZE_MARGIN * maxBytes * 8) / seconds));
  return {
    seconds,
    totalBitrate,
    videoBitrate: totalBitrate - AUDIO_BITRATE,
    audioBitrate: AUDIO_BITRATE,
    longSide: totalBitrate < SMALL_PICTURE_BELOW ? 1280 : 1920,
  };
}

/**
 * The ffmpeg arguments (an array: never a shell). ffmpeg turns a phone's
 * rotated video upright before the scale filter and writes no rotation, so
 * the frames the API extracts are upright too. The picture is never
 * enlarged, and both sides stay even (H.264 4:2:0 needs it).
 */
export function ffmpegArgs(input: string, output: string, plan: CompressionPlan): string[] {
  const factor = `min(1,${plan.longSide}/max(iw,ih))`;
  return [
    '-hide_banner',
    '-nostdin',
    '-y',
    '-i',
    input,
    '-map',
    '0:v:0',
    '-map',
    '0:a:0?',
    '-vf',
    `scale=w='trunc(${factor}*iw/2)*2':h='trunc(${factor}*ih/2)*2'`,
    '-c:v',
    'libx264',
    '-preset',
    'veryfast',
    '-pix_fmt',
    'yuv420p',
    '-b:v',
    String(plan.videoBitrate),
    '-maxrate',
    String(plan.videoBitrate),
    '-bufsize',
    String(plan.videoBitrate * 2),
    '-c:a',
    'aac',
    '-b:a',
    String(plan.audioBitrate),
    '-ac',
    '1',
    // Never longer than the source: AAC padding would otherwise push a 599.9 s
    // video past the API's 10 minutes.
    '-t',
    plan.seconds.toFixed(3),
    '-movflags',
    '+faststart',
    '-progress',
    'pipe:1',
    '-nostats',
    '-loglevel',
    'error',
    output,
  ];
}

/** What ffmpeg or ffprobe said, without its progress lines: the last few lines, for an error message. */
function complaint(output: string): string {
  const lines = output
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !/^[a-z_0-9]+=/.test(line));
  return lines.slice(-3).join(' ').slice(0, 300);
}

export type Probe = { seconds: number } | { seconds: null; reason: string };

/** The duration of the video in seconds, from its container. */
export async function probeDuration(tools: VideoTools, input: string, run: Runner = runProgram): Promise<Probe> {
  const result = await run(tools.ffprobe, ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=noprint_wrappers=1:nokey=1', input], {
    timeoutMs: 60_000,
  });
  if (result.code !== 0) {
    return { seconds: null, reason: result.timedOut ? 'ffprobe timed out' : complaint(result.output) || result.error || `ffprobe exited with ${result.code}` };
  }
  const match = /^\s*(\d+(?:\.\d+)?)\s*$/m.exec(result.output);
  const seconds = match ? Number(match[1]) : NaN;
  if (!Number.isFinite(seconds) || seconds <= 0) return { seconds: null, reason: 'the file does not say how long it lasts' };
  return { seconds };
}

/** Encodes `input` into `output` (an MP4) and returns its size; throws with ffmpeg's own words when it fails. */
export async function compressVideo(options: {
  tools: VideoTools;
  input: string;
  output: string;
  plan: CompressionPlan;
  run?: Runner;
  /** From 0 to 1, as ffmpeg reports how far it got. */
  onProgress?: (fraction: number) => void;
}): Promise<number> {
  const { tools, input, output, plan } = options;
  let pending = '';
  // The runner keeps only the first 64 KB of output, mostly progress: what ffmpeg says otherwise is kept here.
  let said = '';
  const read = (line: string) => {
    // `out_time_ms` is in microseconds too (an old ffmpeg naming).
    const time = /^out_time_(?:us|ms)=(\d+)\s*$/.exec(line);
    if (time) options.onProgress?.(Math.min(1, Number(time[1]) / 1_000_000 / plan.seconds));
    else if (!/^[a-z_0-9]+=/.test(line.trim())) said = `${said}\n${line}`.slice(-2000);
  };
  const result = await (options.run ?? runProgram)(tools.ffmpeg, ffmpegArgs(input, output, plan), {
    // Ten minutes of 4K on a slow computer; a stuck ffmpeg does not hold the terminal forever.
    timeoutMs: 60 * 60_000,
    onOutput: (text) => {
      const lines = (pending + text).split('\n');
      pending = lines.pop() ?? '';
      lines.forEach(read);
    },
  });
  read(pending);
  if (result.code !== 0) {
    const why = result.timedOut ? 'it took more than an hour' : complaint(said) || result.error || `ffmpeg exited with ${result.code}`;
    throw new Error(`ffmpeg could not compress the video: ${why}`);
  }
  return (await stat(output)).size;
}

/** How to install ffmpeg (with ffprobe) here, as a hint. */
export function installFfmpeg(platform: NodeJS.Platform): string {
  if (platform === 'darwin') return '`brew install ffmpeg`';
  if (platform === 'win32') return '`winget install ffmpeg`';
  return '`sudo apt install ffmpeg`, or your package manager';
}
