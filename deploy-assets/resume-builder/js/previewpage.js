// Read-only document preview, addressable in another tab without leaving Tailor.
import { store } from './store.js';
import { renderDoc, esc } from './templates.js';
import { pageSize } from './data.js';
import { paginate } from './paginate.js';
import { fitPages } from './preview.js';
import { downloadPdf } from './editor.js';

export function previewPage(id) {
  const doc = store.get(id);
  if (!doc) return '<section class="section"><h1>Document not found</h1><p>It may have been deleted, or belong to another account.</p><a class="btn" href="#documents">My documents</a></section>';
  return `<section class="document-preview" data-preview-id="${esc(id)}">
    <header class="preview-toolbar"><h1>${esc(doc.title)}</h1><span data-preview-count role="status"></span>
      <button class="btn btn-primary" data-preview-download>Download PDF</button>
      <a class="btn btn-ghost" href="#edit-${esc(id)}">Open to edit</a></header>
    <div class="preview-desk"><div class="page-fit">${renderDoc(doc)}</div></div>
  </section>`;
}

export function mountPreview() {
  const root = document.querySelector('[data-preview-id]');
  if (!root) return;
  const doc = store.get(root.dataset.previewId);
  const layout = () => {
    if (!root.isConnected) return;
    const count = paginate(root.querySelector('.page'), pageSize(doc).H);
    root.querySelector('[data-preview-count]').textContent = `${count} page${count === 1 ? '' : 's'}`;
    fitPages(root);
  };
  layout();
  document.fonts.ready.then(layout);
  const button = root.querySelector('[data-preview-download]');
  button.addEventListener('click', () => downloadPdf(doc, button));
}
