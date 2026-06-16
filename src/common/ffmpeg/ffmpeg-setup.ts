// eslint-disable-next-line @typescript-eslint/no-require-imports
const ffmpeg = require('fluent-ffmpeg');
// eslint-disable-next-line @typescript-eslint/no-require-imports
const ffmpegStatic = require('ffmpeg-static');
// eslint-disable-next-line @typescript-eslint/no-require-imports
const ffprobeInstaller = require('@ffprobe-installer/ffprobe');

ffmpeg.setFfmpegPath(ffmpegStatic);
ffmpeg.setFfprobePath(ffprobeInstaller.path);

export default ffmpeg;
