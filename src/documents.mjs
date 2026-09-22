import { randomUUID } from 'node:crypto';
import { documentSchema } from './schema.mjs';
import { AppError, permit, found } from './errors.mjs';
import { requestRow, seesAllRequests, MAKER_ROLES } from './requests.mjs';
import { isEditable } from './workflow.mjs';

// Supporting documents. Stored in the database rather than on disk so a backup of the
// database is a complete record, and served back only as downloads, never inline HTML.
export const MAX_BYTES = 7_000_000;
export const ALLOWED_MIME = ['application/pdf', 'image/jpeg', 'image/png', 'image/webp', 'image/heic', 'image/tiff'];

export function uploadDocument(store, actor, requestId, input) {
  permit(actor, [...MAKER_ROLES, 'approver']);
  const value = documentSchema.parse(input);
  if (!ALLOWED_MIME.includes(value.mime)) throw new AppError(`Attach a PDF or an image. "${value.mime}" is not accepted.`);
  const content = Buffer.from(value.content, 'base64');
  if (!content.length) throw new AppError('The attached file is empty.');
  if (content.length > MAX_BYTES) throw new AppError(`Attachments are limited to ${Math.floor(MAX_BYTES / 1_000_000)} MB.`, 413);
  return store.transaction(() => {
    const row = requestRow(store, requestId);
    if (!seesAllRequests(actor) && row.maker_id !== actor.id) throw new AppError('Request not found.', 404);
    // Makers may attach only while the request is still theirs to edit; reviewers may add
    // evidence at any time, which is recorded in the history like every other action.
    if (actor.role === 'maker' && !isEditable(row.status)) throw new AppError('A submitted request can no longer be changed by its maker. Ask an approver to attach the document.', 409);
    const document = { id: randomUUID(), name: value.name, mime: value.mime, size: content.length, uploadedBy: actor.fullName, uploadedAt: new Date().toISOString() };
    store.run('INSERT INTO documents(id, request_id, name, mime, size, uploaded_by, uploaded_at, content) VALUES(?,?,?,?,?,?,?,?)',
      document.id, requestId, document.name, document.mime, document.size, document.uploadedBy, document.uploadedAt, content);
    store.log(actor, 'attach', 'request', requestId, { status: row.status, detail: `Supporting document attached: ${document.name}` });
    return document;
  });
}

export function getDocument(store, actor, id) {
  const row = found(store.get('SELECT * FROM documents WHERE id = ?', id), 'Document');
  const request = requestRow(store, row.request_id);
  if (!seesAllRequests(actor) && request.maker_id !== actor.id) throw new AppError('Document not found.', 404);
  return { name: row.name, mime: row.mime, content: row.content, requestNumber: request.number };
}
