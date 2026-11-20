const fs = require('fs/promises');
const path = require('path');
const { randomUUID } = require('crypto');

const uploadDirectory = path.join(__dirname, '..', 'public', 'uploads', 'events');

async function saveEventPhoto(file) {
  if (!file) return null;
  await fs.mkdir(uploadDirectory, { recursive: true });
  const filename = `${randomUUID()}.${file.detectedExtension}`;
  await fs.writeFile(path.join(uploadDirectory, filename), file.buffer, { flag: 'wx' });
  return `/uploads/events/${filename}`;
}

async function deleteEventPhoto(photoPath) {
  if (typeof photoPath !== 'string' || !photoPath.startsWith('/uploads/events/')) return;
  const filename = path.basename(photoPath);
  if (!/^[0-9a-f-]+\.(jpg|png|webp|gif)$/i.test(filename)) return;
  await fs.unlink(path.join(uploadDirectory, filename)).catch(error => {
    if (error.code !== 'ENOENT') throw error;
  });
}

module.exports = { saveEventPhoto, deleteEventPhoto };
