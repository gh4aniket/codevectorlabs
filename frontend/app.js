/**
 * app.js — Product Browser frontend (vanilla JS, no build step)
 *
 * Pagination model
 * ----------------
 * We maintain a single map:  pageMap[pageNumber] = cursorToken
 *
 *   pageMap[1] is always null  (first page needs no cursor)
 *   pageMap[2] = the nextCursor returned by page 1's response
 *   pageMap[3] = the nextCursor returned by page 2's response
 *   …and so on.
 *
 * currentPage tracks which page is on screen right now.
 *
 * Next page:
 *   - If pageMap[currentPage + 1] already exists → fetch with that cursor directly.
 *   - Otherwise the API for the current page hasn't been called yet for its
 *     nextCursor; this shouldn't happen in practice (we always store the
 *     nextCursor immediately after every fetch), but as a safety fallback
 *     we can re-fetch the current page to get it.
 *
 * Previous page:
 *   - Always available as pageMap[currentPage - 1]  (populated when we first
 *     fetched that page or the page before it).
 *
 * Jump to page N (Go To):
 *   - If pageMap[N] exists → direct fetch with that cursor.
 *   - Otherwise walk forward from the highest known page, fetching each
 *     intermediate page purely to collect its nextCursor, until we reach N.
 *     Every intermediate cursor is stored in pageMap so the walk only ever
 *     happens once per page.
 *
 * No stack is maintained anywhere. There is no push/pop. The map grows
 * monotonically as pages are visited.
 */

const API_BASE = 'http://localhost:3000';

// ---------------------------------------------------------------------
// State
// ---------------------------------------------------------------------

/**
 * pageMap[n] = the cursor token needed to FETCH page n.
 * pageMap[1] is permanently null.
 * @type {Object.<number, string|null>}
 */
let pageMap = { 1: null };

/** Which page is currently displayed. */
let currentPage = 1;

/** Highest page number we have a cursor entry for. */
let highestKnownPage = 1;

/** Set once any page comes back with hasNextPage === false. */
let knownLastPage = null;

let currentCategory = '';
let currentLimit = 20;
let isLoading = false;

// ---------------------------------------------------------------------
// DOM refs
// ---------------------------------------------------------------------

const el = {
  categorySelect: document.getElementById('categorySelect'),
  limitSelect: document.getElementById('limitSelect'),
  resetBtn: document.getElementById('resetBtn'),
  prevBtn: document.getElementById('prevBtn'),
  nextBtn: document.getElementById('nextBtn'),
  productsBody: document.getElementById('productsBody'),
  emptyState: document.getElementById('emptyState'),
  tableStatus: document.getElementById('tableStatus'),
  // The left-rail stack visualization is repurposed to show the map
  cursorStackEl: document.getElementById('cursorStack'),
  stackDepth: document.getElementById('stackDepth'),
  currentPageNum: document.getElementById('currentPageNum'),
  totalCountValue: document.getElementById('totalCountValue'),
  pageRangeLabel: document.getElementById('pageRangeLabel'),
  gotoInput: document.getElementById('gotoInput'),
  gotoBtn: document.getElementById('gotoBtn'),
  gotoMaxHint: document.getElementById('gotoMaxHint'),
  gotoStatus: document.getElementById('gotoStatus'),
};

// ---------------------------------------------------------------------
// API
// ---------------------------------------------------------------------

async function fetchProducts({ category, cursor, limit }) {
  const params = new URLSearchParams();
  if (category) params.set('category', category);
  if (cursor) params.set('cursor', cursor);
  params.set('limit', String(limit));

  const res = await fetch(`${API_BASE}/products?${params.toString()}`);
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || `Request failed (${res.status})`);
  }
  return res.json();
}

async function fetchCategories() {
  const res = await fetch(`${API_BASE}/categories`);
  if (!res.ok) throw new Error('Failed to load categories');
  return res.json();
}

// ---------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------

function setStatus(message, variant) {
  if (!message) {
    el.tableStatus.hidden = true;
    return;
  }
  el.tableStatus.hidden = false;
  el.tableStatus.textContent = message;
  if (variant) el.tableStatus.dataset.variant = variant;
  else delete el.tableStatus.dataset.variant;
}

function formatDate(iso) {
  const d = new Date(iso);
  return d.toISOString().replace('T', ' ').slice(0, 19);
}

function renderProducts(products) {
  el.productsBody.innerHTML = '';
  el.emptyState.hidden = products.length > 0;

  for (const p of products) {
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td>${p.id}</td>
      <td>${escapeHtml(p.name)}</td>
      <td><span class="category-tag">${escapeHtml(p.category)}</span></td>
      <td class="ptable__num">$${p.price.toFixed(2)}</td>
      <td>${formatDate(p.createdAt)}</td>
      <td>${formatDate(p.updatedAt)}</td>
    `;
    el.productsBody.appendChild(tr);
  }
}

function renderPageInfo(pageInfo) {
  el.totalCountValue.textContent = pageInfo.totalCount.toLocaleString();

  const startIdx = (currentPage - 1) * currentLimit + 1;
  const endIdx = startIdx + pageInfo.count - 1;

  el.pageRangeLabel.textContent =
    pageInfo.count > 0
      ? `Showing ${startIdx}–${endIdx} of ${pageInfo.totalCount.toLocaleString()}`
      : 'No results';

  el.prevBtn.disabled = currentPage <= 1;
  el.nextBtn.disabled = !pageInfo.hasNextPage;

  if (!pageInfo.hasNextPage) knownLastPage = currentPage;
  updateGotoBounds(pageInfo.totalCount);
}

/**
 * Store the cursor needed to reach the NEXT page (pageNum + 1).
 * Called after every successful fetch so the map is always up-to-date.
 */
function storeNextCursor(pageNum, pageInfo) {
  if (pageInfo.hasNextPage && pageInfo.nextCursor) {
    pageMap[pageNum + 1] = pageInfo.nextCursor;
    if (pageNum + 1 > highestKnownPage) highestKnownPage = pageNum + 1;
  }
}

function updateGotoBounds(totalCount) {
  if (el.gotoMaxHint && currentLimit > 0) {
    const maxPage = Math.max(1, Math.ceil(totalCount / currentLimit));
    el.gotoMaxHint.textContent = `of ${maxPage.toLocaleString()}`;
    el.gotoInput.max = String(maxPage);
  }
}

function renderGotoStatus(message, variant) {
  if (!el.gotoStatus) return;
  el.gotoStatus.textContent = message || '';
  if (variant) el.gotoStatus.dataset.variant = variant;
  else delete el.gotoStatus.dataset.variant;
}

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

function setLoading(loading) {
  isLoading = loading;
  el.prevBtn.disabled = loading || currentPage <= 1;
  if (loading) {
    el.nextBtn.disabled = true;
    setStatus('Loading products…');
  }
}

// ---------------------------------------------------------------------
// Core load — fetch a specific page by number using pageMap
// ---------------------------------------------------------------------

/**
 * Fetch and display the given page number.
 * Requires pageMap[pageNum] to already exist (i.e. we know the cursor for it).
 */
async function loadPage(pageNum) {
  if (isLoading) return;
  setLoading(true);

  const cursor = pageMap[pageNum]; // null for page 1, token otherwise

  try {
    const data = await fetchProducts({
      category: currentCategory,
      cursor,
      limit: currentLimit,
    });

    // Record the cursor for the next page so forward navigation is instant.
    storeNextCursor(pageNum, data.pageInfo);

    currentPage = pageNum;

    renderProducts(data.products);
    renderPageInfo(data.pageInfo);
  el.currentPageNum.textContent = String(currentPage);
    renderGotoStatus(null);
    setStatus(null);
  } catch (err) {
    console.error(err);
    setStatus(err.message || 'Something went wrong loading products.', 'error');
    el.nextBtn.disabled = true;
  } finally {
    setLoading(false);
  }
}

// ---------------------------------------------------------------------
// Navigation
// ---------------------------------------------------------------------

function goToNextPage() {
  if (isLoading) return;
  const nextPage = currentPage + 1;
  // The cursor for the next page is always stored right after we fetched
  // the current page (see storeNextCursor). If somehow it's missing we bail.
  if (!(nextPage in pageMap)) {
    setStatus('Next page cursor not available yet.', 'error');
    return;
  }
  loadPage(nextPage);
}

function goToPreviousPage() {
  if (currentPage <= 1 || isLoading) return;
  // Previous page's cursor is always in pageMap — it was there before
  // we ever fetched the current page.
  loadPage(currentPage - 1);
}

function resetToFirstPage() {
  currentPage = 1;
  loadPage(1);
}

// ---------------------------------------------------------------------
// Direct page jump ("go to page N")
//
// pageMap[N] tells us the cursor to fetch page N directly.
// If we don't have it yet, we walk forward from the highest known page,
// fetching each intermediate page to collect its nextCursor, storing
// each one in pageMap as we go. Once pageMap[N] is populated we do
// the final real fetch for that page.
//
// Every intermediate cursor is permanently cached in pageMap so the
// walk only ever happens once per page, regardless of how many times
// a user jumps to that page or nearby pages.
// ---------------------------------------------------------------------

/** Low-level fetch that only returns the data without changing display state. */
async function fetchPageRaw(cursor) {
  return fetchProducts({ category: currentCategory, cursor, limit: currentLimit });
}

async function goToPage(targetPage) {
  if (isLoading) return;

  if (!Number.isInteger(targetPage) || targetPage < 1) {
    renderGotoStatus('Enter a page number of 1 or more.', 'error');
    return;
  }
  if (knownLastPage !== null && targetPage > knownLastPage) {
    renderGotoStatus(`Only ${knownLastPage} page(s) exist for this filter.`, 'error');
    return;
  }

  // If we already know the cursor for this page, just load it directly.
  if (targetPage in pageMap) {
    loadPage(targetPage);
    return;
  }

  // Walk forward from the highest page we have a cursor for.
  setLoading(true);
  renderGotoStatus(`Jumping to page ${targetPage}…`);

  try {
    // Find the highest page already in pageMap that is ≤ targetPage.
    let walkFrom = highestCachedPageAtOrBelow(targetPage);

    // Walk page-by-page, storing each nextCursor into pageMap.
    while (!(targetPage in pageMap)) {
      const cursorForWalkFrom = pageMap[walkFrom];
      const data = await fetchPageRaw(cursorForWalkFrom);

      // Store the cursor for the page after walkFrom.
      storeNextCursor(walkFrom, data.pageInfo);

      if (!data.pageInfo.hasNextPage) {
        // Real end of data reached before targetPage.
        knownLastPage = walkFrom;
        renderGotoStatus(`Only ${walkFrom} page(s) exist for this filter.`, 'error');
        setLoading(false);
        return;
      }

      walkFrom += 1;
    }

    // pageMap[targetPage] is now populated — do the real rendered fetch.
    setLoading(false);
    loadPage(targetPage);
  } catch (err) {
    console.error(err);
    renderGotoStatus(err.message || 'Failed to jump to that page.', 'error');
    setLoading(false);
  }
}

function highestCachedPageAtOrBelow(targetPage) {
  let best = 1;
  for (const key of Object.keys(pageMap)) {
    const n = Number(key);
    if (n <= targetPage && n > best) best = n;
  }
  return best;
}

function onGotoSubmit() {
  const targetPage = parseInt(el.gotoInput.value, 10);
  goToPage(targetPage);
}

// ---------------------------------------------------------------------
// Filters
// ---------------------------------------------------------------------

async function initCategoryFilter() {
  try {
    const { categories } = await fetchCategories();
    for (const cat of categories) {
      const opt = document.createElement('option');
      opt.value = cat.name;
      opt.textContent = `${cat.name} (${cat.count.toLocaleString()})`;
      el.categorySelect.appendChild(opt);
    }
  } catch (err) {
    console.error('Failed to load categories:', err);
    // Non-fatal: "All categories" still works without this list.
  }
}

function onCategoryChange() {
  currentCategory = el.categorySelect.value;
  // Changing the filter invalidates all previously discovered cursors —
  // cursors are specific to a query shape (category + limit).
  invalidatePageMap();
  resetToFirstPage();
}

function onLimitChange() {
  currentLimit = parseInt(el.limitSelect.value, 10);
  // Page size changes which row falls at each boundary, so all old
  // cursors are meaningless for the new page size.
  invalidatePageMap();
  resetToFirstPage();
}

/** Wipe everything keyed to the old query shape. */
function invalidatePageMap() {
  pageMap = { 1: null };
  highestKnownPage = 1;
  knownLastPage = null;
  currentPage = 1;
}

// ---------------------------------------------------------------------
// Wire up
// ---------------------------------------------------------------------

el.nextBtn.addEventListener('click', goToNextPage);
el.prevBtn.addEventListener('click', goToPreviousPage);
el.resetBtn.addEventListener('click', resetToFirstPage);
el.categorySelect.addEventListener('change', onCategoryChange);
el.limitSelect.addEventListener('change', onLimitChange);

if (el.gotoBtn) el.gotoBtn.addEventListener('click', onGotoSubmit);
if (el.gotoInput) {
  el.gotoInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') onGotoSubmit();
  });
}

initCategoryFilter();
loadPage(1);