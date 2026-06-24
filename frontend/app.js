
const API_BASE = 'https://codevectorlabs-snv8.onrender.com';

let pageMap = { 1: null };


let currentPage = 1;


let highestKnownPage = 1;


let knownLastPage = null;

let currentCategory = '';
let currentLimit = 20;
let isLoading = false;

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



async function loadPage(pageNum) {
  if (isLoading) return;
  setLoading(true);

  const cursor = pageMap[pageNum]; 

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


function goToNextPage() {
  if (isLoading) return;
  const nextPage = currentPage + 1;

  if (!(nextPage in pageMap)) {
    setStatus('Next page cursor not available yet.', 'error');
    return;
  }
  loadPage(nextPage);
}

function goToPreviousPage() {
  if (currentPage <= 1 || isLoading) return;
 
  loadPage(currentPage - 1);
}

function resetToFirstPage() {
  currentPage = 1;
  loadPage(1);
}

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

 
  if (targetPage in pageMap) {
    loadPage(targetPage);
    return;
  }

  setLoading(true);
  renderGotoStatus(`Jumping to page ${targetPage}…`);

  try {
 
    let walkFrom = highestCachedPageAtOrBelow(targetPage);


    while (!(targetPage in pageMap)) {
      const cursorForWalkFrom = pageMap[walkFrom];
      const data = await fetchPageRaw(cursorForWalkFrom);

    
      storeNextCursor(walkFrom, data.pageInfo);

      if (!data.pageInfo.hasNextPage) {

        knownLastPage = walkFrom;
        renderGotoStatus(`Only ${walkFrom} page(s) exist for this filter.`, 'error');
        setLoading(false);
        return;
      }

      walkFrom += 1;
    }

   
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
  
  }
}

function onCategoryChange() {
  currentCategory = el.categorySelect.value;

  invalidatePageMap();
  resetToFirstPage();
}

function onLimitChange() {
  currentLimit = parseInt(el.limitSelect.value, 10);
  
  invalidatePageMap();
  resetToFirstPage();
}


function invalidatePageMap() {
  pageMap = { 1: null };
  highestKnownPage = 1;
  knownLastPage = null;
  currentPage = 1;
}


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
