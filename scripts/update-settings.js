import fs from 'node:fs';

const filePath = '/opt/yt-live-manager/config/settings.json';
const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
data.stream.x264Preset = 'ultrafast';
fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf8');
console.log('Successfully set x264Preset to ultrafast');
