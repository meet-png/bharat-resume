// Supabase Storage upload + signed URL. PRD §3 (Storage row), §5 Phase 3 step 5.
// Signed URL TTL: 60s.
const { getClient } = require('./postgres');
const { config } = require('../config');

async function uploadPdf(_path, _buffer) {
  // TODO Day 4: getClient().storage.from(config.SUPABASE_STORAGE_BUCKET).upload(path, buffer, ...)
  throw new Error('uploadPdf not implemented (Day 4)');
}

async function createSignedUrl(_path) {
  // TODO Day 4: getClient().storage.from(bucket).createSignedUrl(path, 60)
  throw new Error('createSignedUrl not implemented (Day 4)');
}

module.exports = { uploadPdf, createSignedUrl, BUCKET: config.SUPABASE_STORAGE_BUCKET };
