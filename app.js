// Global Application State
const state = {
  db: null,
  tables: [],
  categories: [],
  products: [],
  salesHistory: [],

  // Selections
  activeTab: 'dashboard',
  selectedTableId: null,
  selectedCategoryFilter: 'all', // For menu manager
  selectedFastCategoryFilter: 'all', // For slide-over quick picker
  activeTableFilter: 'all', // For dashboard tables grid
  taxRate: 15,

  // Reports Page Filter
  reportsFilter: {
    type: 'all', // 'all', 'today', 'custom'
    startDate: '',
    endDate: ''
  },

  // Current Order Cart Draft (while slide-over is open)
  currentCart: {
    items: [],
    customerName: '',
    customerCount: 1,
    startTime: null
  }
};

/**
 * Formats pricing as Syrian Lira (ل.س) with thousands separator and rounded whole number.
 */
function formatCurrency(amount) {
  return Math.round(amount || 0).toLocaleString('en-US') + ' ل.س';
}

// ==========================================================================
// Initialization & Startup
// ==========================================================================

document.addEventListener('DOMContentLoaded', async () => {
  try {
    // 1. Start clock widget immediately so UI is alive
    initClock();

    // 2. Hook up window-level events
    setupGlobalEventListeners();

    // 3. Render default tab and setup shell
    switchTab('dashboard');

    // 4. Initialize Firebase database connection
    state.db = new BistroDatabase();
    const isConfigured = await state.db.init();

    if (!isConfigured) {
      alert('لم يتم إعداد قاعدة بيانات Firebase بعد أو فشل الاتصال بها. يرجى إدخال إعدادات الاتصال الصحيحة داخل ملف database.js لتشغيل المزامنة السحابية.');
    } else {
      // 5. Seed data if first run on connected cloud
      await state.db.seedIfEmpty();
    }

    // 6. Load data from DB into state (handles fallback to empty gracefully)
    await refreshStateData();

    // 7. Check Daily Backup Warning
    checkDailyBackupReminder();

    console.log('Bistro POS initialized successfully.');
  } catch (error) {
    console.error('Initialization failed:', error);
    alert('حدث خطأ أثناء تحميل قاعدة البيانات. يرجى التحقق من إعدادات Firebase والاتصال بالإنترنت.');
  }
});

/**
 * Refreshes local state arrays from database.
 */
async function refreshStateData() {
  if (!state.db) return;
  state.tables = await state.db.getTables();
  state.categories = await state.db.getCategories();

  // Sort categories by custom drag-and-drop sortOrder
  state.categories.sort((a, b) => (a.sortOrder || 0) - (b.sortOrder || 0));

  state.products = await state.db.getProducts();
  state.salesHistory = await state.db.getSalesHistory();

  // Fetch settings (tax rate and dynamic branding parameters)
  try {
    const settings = await state.db.getAll('settings');

    // Tax Rate
    const taxRateSetting = settings.find(s => s.id === 'tax_rate');
    state.taxRate = taxRateSetting ? parseFloat(taxRateSetting.value) : 15;

    // Dynamic Brand customization parameters
    const brandNameSetting = settings.find(s => s.id === 'restaurant_name');
    state.restaurantName = brandNameSetting ? brandNameSetting.value : 'Restaurant';

    const brandSloganSetting = settings.find(s => s.id === 'restaurant_slogan');
    state.restaurantSlogan = brandSloganSetting ? brandSloganSetting.value : 'Welcome';

    const brandLogoSetting = settings.find(s => s.id === 'restaurant_logo');
    state.restaurantLogo = brandLogoSetting ? brandLogoSetting.value : './assets/logo.png';

    const brandFooterSetting = settings.find(s => s.id === 'restaurant_footer');
    state.restaurantFooter = brandFooterSetting ? brandFooterSetting.value : 'Have a nice day!';
  } catch (err) {
    console.error('Failed to load settings from DB. Applying defaults:', err);
    state.taxRate = 15;
    state.restaurantName = 'Restaurant';
    state.restaurantSlogan = 'Welcome';
    state.restaurantLogo = './assets/logo.png';
    state.restaurantFooter = 'Have a nice day!';
  }

  // Populate UI inputs with settings values
  const taxRateInput = document.getElementById('settings-tax-rate');
  if (taxRateInput) {
    taxRateInput.value = state.taxRate;
  }

  // Perform global brand UI update
  updateBrandUI();

  // Recalculate and update top header stats
  updateGlobalStatsUI();
}

/**
 * Periodically updates the live clock on the sidebar.
 */
function initClock() {
  const timeDisplay = document.getElementById('time-display');
  const dateDisplay = document.getElementById('date-display');

  const updateTime = () => {
    const now = new Date();

    // Format Time
    timeDisplay.textContent = now.toLocaleTimeString('ar-SA', {
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hour12: false
    });

    // Format Date
    dateDisplay.textContent = now.toLocaleDateString('ar-EG', {
      weekday: 'long',
      day: 'numeric',
      month: 'long'
    });
  };

  updateTime();
  setInterval(updateTime, 1000);
}

// ==========================================================================
// Navigation & Tab Switching
// ==========================================================================

function switchTab(tabId) {
  state.activeTab = tabId;

  // 1. Update navigation button states
  document.querySelectorAll('.nav-item').forEach(btn => btn.classList.remove('active'));
  const activeBtn = document.getElementById(`nav-btn-${tabId}`);
  if (activeBtn) activeBtn.classList.add('active');

  // 2. Toggle active view panel
  document.querySelectorAll('.tab-view').forEach(view => view.classList.remove('active'));
  const activeView = document.getElementById(`view-${tabId}`);
  if (activeView) activeView.classList.add('active');

  // 3. Update Header titles
  const tabTitle = document.getElementById('current-tab-title');
  const tabDesc = document.getElementById('current-tab-desc');

  switch (tabId) {
    case 'dashboard':
      tabTitle.textContent = 'الصالة وإدارة الطاولات';
      tabDesc.textContent = 'نظرة عامة على حالة الطاولات والطلبات النشطة في الصالة والتحكم بها.';
      renderDashboard();
      break;
    case 'menu':
      tabTitle.textContent = 'قائمة الطعام';
      tabDesc.textContent = 'إدارة وتعديل أطعمة ومشروبات المطعم، إضافة منتجات جديدة أو تصنيفات.';
      renderMenuManager();
      break;
    case 'tables':
      tabTitle.textContent = 'إدارة طاولات الصالة';
      tabDesc.textContent = 'إضافة وتعديل طاولات المطعم وسعتها المقعدية.';
      renderTablesSettings();
      break;
    case 'reports':
      tabTitle.textContent = 'الفواتير والتقارير المالية';
      tabDesc.textContent = 'مراجعة المبيعات الإجمالية اليومية، واستعراض فواتير الدفع المكتملة.';
      renderReports();
      break;
  }
}

// ==========================================================================
// Global Event Listeners & Modals
// ==========================================================================

function setupGlobalEventListeners() {
  // Listen for Escape key to close modals/slideover
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      closeOrderSlideOver();
      document.querySelectorAll('.modal-backdrop').forEach(modal => {
        modal.classList.remove('active');
      });
    }
  });
}

function openModal(modalId) {
  document.getElementById(modalId).classList.add('active');
}

function closeModal(modalId) {
  document.getElementById(modalId).classList.remove('active');
}

// ==========================================================================
// Stats Calculation & Header Updates
// ==========================================================================

function updateGlobalStatsUI() {
  // Calculate stats
  const activeTablesCount = state.tables.filter(t => t.status !== 'available').length;

  // Sum today's sales from history
  const today = new Date().toDateString();
  const todaySales = state.salesHistory
    .filter(sale => new Date(sale.timestamp).toDateString() === today)
    .reduce((sum, sale) => sum + (sale.total || 0), 0);

  const completedTodayCount = state.salesHistory
    .filter(sale => new Date(sale.timestamp).toDateString() === today).length;

  // Update DOM elements in top header and dashboard view
  const headerSales = document.getElementById('today-sales-header');
  if (headerSales) headerSales.textContent = formatCurrency(todaySales);

  const dActiveTables = document.getElementById('stat-active-tables');
  if (dActiveTables) dActiveTables.textContent = `${activeTablesCount} / ${state.tables.length}`;

  const dTotalRev = document.getElementById('stat-total-revenue');
  if (dTotalRev) dTotalRev.textContent = formatCurrency(todaySales);

  const dCompleted = document.getElementById('stat-completed-orders');
  if (dCompleted) dCompleted.textContent = `${completedTodayCount} فاتورة`;
}

// ==========================================================================
// 1. Dashboard View - Tables Grid
// ==========================================================================

async function renderDashboard() {
  await refreshStateData();
  const gridContainer = document.getElementById('tables-grid-container');
  if (!gridContainer) return;

  gridContainer.innerHTML = '';

  // Filter tables based on active state filter
  const filteredTables = state.tables.filter(tbl => {
    if (state.activeTableFilter === 'all') return true;
    return tbl.status === state.activeTableFilter;
  });

  if (filteredTables.length === 0) {
    gridContainer.innerHTML = `<div class="loading-placeholder">لا توجد طاولات تطابق التصفية الحالية.</div>`;
    return;
  }

  // Render each table card
  for (const tbl of filteredTables) {
    const card = document.createElement('div');
    card.className = `table-card ${tbl.status}`;
    card.onclick = () => openOrderSlideOver(tbl.id);

    // Fetch current active order to display sum
    let orderAmountHtml = '';
    let timeElapsedHtml = '';

    if (tbl.status !== 'available') {
      const activeOrder = await state.db.getActiveOrder(tbl.id);
      if (activeOrder && activeOrder.items.length > 0) {
        const subtotal = activeOrder.items.reduce((sum, item) => {
          const itemTotal = item.isHospitality ? 0 : (item.price * item.quantity);
          return sum + itemTotal;
        }, 0);
        const taxRate = state.taxRate !== undefined ? state.taxRate : 15;
        const total = subtotal * (1 + taxRate / 100);
        orderAmountHtml = `<div class="table-order-amount">${formatCurrency(total)}</div>`;
      } else {
        orderAmountHtml = `<div class="table-order-amount">${formatCurrency(0)}</div>`;
      }

      // Calculate elapsed time since start
      if (activeOrder && activeOrder.startTime) {
        const elapsedMin = Math.round((Date.now() - activeOrder.startTime) / 60000);
        timeElapsedHtml = `
          <div class="table-time-elapsed">
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>
            منذ ${elapsedMin} دقيقة
          </div>`;
      }
    }

    let statusLabelText = 'فارغة';
    if (tbl.status === 'occupied') statusLabelText = 'مشغولة';
    if (tbl.status === 'billing') statusLabelText = 'طلب الحساب';

    card.innerHTML = `
      <div class="table-number-circle">${tbl.number}</div>
      <div class="table-capacity">السعة: ${tbl.capacity} أفراد</div>
      <div class="table-status-label">${statusLabelText}</div>
      ${orderAmountHtml}
      ${timeElapsedHtml}
    `;

    gridContainer.appendChild(card);
  }
}

function filterTables(filterType) {
  state.activeTableFilter = filterType;

  // Update active button state
  document.querySelectorAll('.filter-btn').forEach(btn => btn.classList.remove('active'));
  document.getElementById(`table-filter-${filterType}`).classList.add('active');

  renderDashboard();
}

// Quick Add Table from Dashboard
function openAddTableQuickModal() {
  document.getElementById('table-form-id').value = '';
  document.getElementById('table-form-number').value = (state.tables.length + 1).toString();
  document.getElementById('table-form-capacity').value = '4';
  document.getElementById('table-modal-title').textContent = 'إضافة طاولة سريعة';
  openModal('modal-table');
}

// ==========================================================================
// 2. Order Slide-Over Panel Logic (POS Screen)
// ==========================================================================

async function openOrderSlideOver(tableId) {
  state.selectedTableId = tableId;
  const table = state.tables.find(t => t.id === tableId);
  if (!table) return;

  // 1. Setup Header Info
  document.getElementById('slide-table-badge').textContent = `طاولة ${table.number}`;
  const statusEl = document.getElementById('slide-table-status');
  statusEl.textContent = table.status === 'available' ? 'فارغة وجاهزة' : (table.status === 'occupied' ? 'مشغولة' : 'طلب الحساب');
  statusEl.className = `status-indicator ${table.status}`;

  // 2. Switch panel views based on table state
  const availablePanel = document.getElementById('slide-state-available');
  const occupiedPanel = document.getElementById('slide-state-occupied');

  if (table.status === 'available') {
    availablePanel.classList.add('active');
    occupiedPanel.classList.remove('active');

    // Set capacity label
    document.getElementById('slide-table-capacity-label').textContent = `سعة: ${table.capacity} مقاعد`;

    // Reset form values
    document.getElementById('order-customer-name').value = '';
    document.getElementById('order-guest-count').value = table.capacity;
  } else {
    availablePanel.classList.remove('active');
    occupiedPanel.classList.add('active');

    // Load Active Order into state.currentCart draft
    const activeOrder = await state.db.getActiveOrder(tableId);
    if (activeOrder) {
      state.currentCart.items = activeOrder.items || [];
      state.currentCart.customerName = activeOrder.customerName || '';
      state.currentCart.customerCount = activeOrder.customerCount || 1;
      state.currentCart.startTime = activeOrder.startTime || Date.now();
    } else {
      // Fallback
      state.currentCart.items = [];
      state.currentCart.customerName = '';
      state.currentCart.customerCount = 1;
      state.currentCart.startTime = Date.now();
    }

    // Reset fast menu searches
    document.getElementById('fast-menu-search-input').value = '';
    state.selectedFastCategoryFilter = 'all';

    // Render Cart & Quick Menu Items
    renderCart();
    renderFastCategories();
    renderFastProducts();
  }

  // Show the slideover and backdrop
  document.getElementById('order-slideover').classList.add('active');
  document.getElementById('order-slideover-backdrop').classList.add('active');
}

function closeOrderSlideOver() {
  document.getElementById('order-slideover').classList.remove('active');
  document.getElementById('order-slideover-backdrop').classList.remove('active');

  // Refresh dashboard to reflect any instant state updates
  renderDashboard();
}

/**
 * Starts a new order session for a vacant table.
 */
async function startNewTableOrder() {
  if (!state.selectedTableId) return;

  const customerName = document.getElementById('order-customer-name').value.trim() || 'زبون عام';
  const customerCount = parseInt(document.getElementById('order-guest-count').value) || 2;

  // 1. Create order object
  const newOrder = {
    tableId: state.selectedTableId,
    items: [],
    customerName: customerName,
    customerCount: customerCount,
    startTime: Date.now()
  };

  // 2. Save active order to IndexedDB
  await state.db.saveActiveOrder(state.selectedTableId, newOrder);

  // 3. Update table status to occupied
  await state.db.updateTableStatus(state.selectedTableId, 'occupied');

  // 4. Update memory state arrays
  await refreshStateData();

  // 5. Reload Slideover with occupied view active
  openOrderSlideOver(state.selectedTableId);
}

/**
 * Render items currently in the active table's cart.
 */
function renderCart() {
  const container = document.getElementById('cart-items-container');
  if (!container) return;

  container.innerHTML = '';

  if (state.currentCart.items.length === 0) {
    container.innerHTML = `
      <div class="cart-empty-state">
        لا توجد طلبات مسجلة لهذه الطاولة حتى الآن. اختر منتجات من القائمة لإضافتها.
      </div>`;

    document.getElementById('calc-subtotal').textContent = formatCurrency(0);
    document.getElementById('calc-tax').textContent = formatCurrency(0);
    document.getElementById('calc-total').textContent = formatCurrency(0);
    document.getElementById('cart-items-count').textContent = '0 عناصر';

    const taxRate = state.taxRate !== undefined ? state.taxRate : 15;
    const labelTax = document.getElementById('calc-tax-label');
    if (labelTax) labelTax.textContent = `الخدمة والضريبة (${taxRate}%):`;
    return;
  }

  let subtotal = 0;
  let itemCount = 0;

  state.currentCart.items.forEach((item, index) => {
    const originalTotal = item.price * item.quantity;
    const itemTotal = item.isHospitality ? 0 : originalTotal;
    subtotal += itemTotal;
    itemCount += item.quantity;

    const row = document.createElement('div');
    row.className = `cart-item-row ${item.isHospitality ? 'hospitality' : ''}`;

    let priceDisplayHtml = `
      <span class="item-total-price">${formatCurrency(itemTotal)}</span>
    `;
    if (item.isHospitality) {
      priceDisplayHtml = `
        <div style="display: flex; flex-direction: column; align-items: flex-end;">
          <span style="font-size: 11px; text-decoration: line-through; opacity: 0.6; color: var(--text-muted);">${formatCurrency(originalTotal)}</span>
          <span class="item-total-price" style="color: #193B23; font-weight: bold; font-size: 13px;">0 ل.س <span class="badge-hospitality">ضيافة</span></span>
        </div>
      `;
    }

    row.innerHTML = `
      <div class="cart-item-info">
        <h5>${item.name}</h5>
        <span class="unit-price">${formatCurrency(item.price)}</span>
      </div>
      
      <div class="cart-item-qty-actions">
        <button class="qty-btn" onclick="adjustCartItemQty(${index}, -1)">-</button>
        <span class="qty-val">${item.quantity}</span>
        <button class="qty-btn" onclick="adjustCartItemQty(${index}, 1)">+</button>
      </div>
      
      <div class="cart-item-total-side" style="display: flex; align-items: center; gap: 8px;">
        ${priceDisplayHtml}
        <button class="btn-gift btn-icon-sm ${item.isHospitality ? 'active' : ''}" onclick="toggleCartItemHospitality(${index})" title="ضيافة">
          ض
        </button>
        <button class="btn-trash btn-icon-sm" onclick="removeCartItem(${index})" title="إزالة">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/><line x1="10" y1="11" x2="10" y2="17"/><line x1="14" y1="11" x2="14" y2="17"/></svg>
        </button>
      </div>
    `;
    container.appendChild(row);
  });

  // Math Calculations (dynamic tax rate)
  const taxRate = state.taxRate !== undefined ? state.taxRate : 15;
  const tax = subtotal * (taxRate / 100);
  const total = subtotal + tax;

  document.getElementById('calc-subtotal').textContent = formatCurrency(subtotal);
  const labelTax = document.getElementById('calc-tax-label');
  if (labelTax) labelTax.textContent = `الخدمة والضريبة (${taxRate}%):`;
  document.getElementById('calc-tax').textContent = formatCurrency(tax);
  document.getElementById('calc-total').textContent = formatCurrency(total);
  document.getElementById('cart-items-count').textContent = `${itemCount} عناصر`;
}

/**
 * Toggles the hospitality status of a specific item in the current active cart.
 */
async function toggleCartItemHospitality(index) {
  const item = state.currentCart.items[index];
  if (!item) return;

  item.isHospitality = !item.isHospitality;

  // If active table is selected, synchronize with database immediately
  if (state.selectedTableId) {
    const activeOrder = await state.db.getActiveOrder(state.selectedTableId);
    if (activeOrder) {
      activeOrder.items = state.currentCart.items;
      await state.db.saveActiveOrder(state.selectedTableId, activeOrder);
    }
  }

  renderCart();
}

/**
 * Renders categories as filter tabs inside the slideover POS menu.
 */
function renderFastCategories() {
  const container = document.getElementById('fast-menu-categories-tabs');
  if (!container) return;

  container.innerHTML = '';

  // All button
  const allBtn = document.createElement('button');
  allBtn.className = `fast-cat-btn ${state.selectedFastCategoryFilter === 'all' ? 'active' : ''}`;
  allBtn.textContent = 'الكل';
  allBtn.onclick = () => {
    state.selectedFastCategoryFilter = 'all';
    renderFastCategories();
    renderFastProducts();
  };
  container.appendChild(allBtn);

  // Add other DB categories
  state.categories.forEach(cat => {
    const btn = document.createElement('button');
    btn.className = `fast-cat-btn ${state.selectedFastCategoryFilter === cat.id ? 'active' : ''}`;
    btn.textContent = cat.name;
    btn.onclick = () => {
      state.selectedFastCategoryFilter = cat.id;
      renderFastCategories();
      renderFastProducts();
    };
    container.appendChild(btn);
  });
}

/**
 * Renders product grid in slideover POS for clicking to add to order.
 */
function renderFastProducts() {
  const container = document.getElementById('fast-menu-products-container');
  if (!container) return;

  container.innerHTML = '';

  // Filter products by category tab & search keyword
  const searchVal = document.getElementById('fast-menu-search-input').value.toLowerCase().trim();

  const filtered = state.products.filter(prod => {
    const matchesCategory = state.selectedFastCategoryFilter === 'all' || prod.categoryId === state.selectedFastCategoryFilter;
    const matchesSearch = prod.name.toLowerCase().includes(searchVal);
    return matchesCategory && matchesSearch;
  });

  if (filtered.length === 0) {
    container.innerHTML = `<div class="loading-placeholder">لا توجد منتجات مطابقة.</div>`;
    return;
  }

  filtered.forEach(prod => {
    const item = document.createElement('div');
    item.className = 'fast-prod-item';
    item.style.borderRight = `4px solid ${prod.color || '#d4af37'}`;
    item.onclick = () => addProductToCart(prod);

    item.innerHTML = `
      <div class="prod-title">${prod.name}</div>
      <div class="prod-price">${formatCurrency(prod.price)}</div>
    `;

    container.appendChild(item);
  });
}

function filterFastMenu() {
  renderFastProducts();
}

/**
 * Adds clicked product card to current active cart draft.
 */
function addProductToCart(product) {
  const existingItem = state.currentCart.items.find(item => item.productId === product.id);

  if (existingItem) {
    existingItem.quantity += 1;
  } else {
    state.currentCart.items.push({
      productId: product.id,
      name: product.name,
      price: product.price,
      quantity: 1
    });
  }

  renderCart();
}

function adjustCartItemQty(index, amount) {
  const item = state.currentCart.items[index];
  if (!item) return;

  item.quantity += amount;
  if (item.quantity <= 0) {
    state.currentCart.items.splice(index, 1);
  }

  renderCart();
}

function removeCartItem(index) {
  state.currentCart.items.splice(index, 1);
  renderCart();
}

/**
 * Saves current draft order modifications to IndexedDB.
 */
async function saveCurrentOrderState() {
  if (!state.selectedTableId) return;

  const activeOrder = await state.db.getActiveOrder(state.selectedTableId);
  if (activeOrder) {
    activeOrder.items = state.currentCart.items;
    await state.db.saveActiveOrder(state.selectedTableId, activeOrder);

    // If table was billing but they modified/saved items, let's keep status as is or make occupied.
    // It's usually better to keep occupied.
    if (state.tables.find(t => t.id === state.selectedTableId).status === 'billing') {
      await state.db.updateTableStatus(state.selectedTableId, 'occupied');
    }

    await refreshStateData();
    closeOrderSlideOver();
  }
}

/**
 * Changes table status to Yellow billing mode.
 */
async function markTableForBilling() {
  if (!state.selectedTableId) return;

  // 1. Save current items list draft first
  const activeOrder = await state.db.getActiveOrder(state.selectedTableId);
  if (activeOrder) {
    activeOrder.items = state.currentCart.items;
    await state.db.saveActiveOrder(state.selectedTableId, activeOrder);
  }

  // 2. Toggle status to billing
  await state.db.updateTableStatus(state.selectedTableId, 'billing');
  await refreshStateData();

  closeOrderSlideOver();
}

// ==========================================================================
// 3. Checkout Confirmation & Bill Finalization
// ==========================================================================

function openCheckoutConfirmModal() {
  if (!state.selectedTableId) return;
  const table = state.tables.find(t => t.id === state.selectedTableId);
  if (!table) return;

  // Update header and time
  document.getElementById('chk-table-label').textContent = `فاتورة طاولة ${table.number}`;
  document.getElementById('chk-time-label').textContent = `وقت الدخول: ${new Date(state.currentCart.startTime).toLocaleTimeString('ar-SA')}`;

  // Render checkout products list
  const container = document.getElementById('chk-items-container');
  container.innerHTML = '';

  let subtotal = 0;

  state.currentCart.items.forEach(item => {
    const originalTotal = item.price * item.quantity;
    const totalItem = item.isHospitality ? 0 : originalTotal;
    subtotal += totalItem;

    const row = document.createElement('div');
    row.className = `receipt-details-row ${item.isHospitality ? 'hospitality' : ''}`;

    if (item.isHospitality) {
      row.innerHTML = `
        <span>${item.name} (x${item.quantity}) <span class="badge-hospitality" style="margin-right: 6px;">ضيافة</span></span>
        <span style="display: flex; gap: 8px; align-items: center;">
          <span style="text-decoration: line-through; opacity: 0.5;">${formatCurrency(originalTotal)}</span>
          <span style="color: #193B23; font-weight: bold;">0 ل.س</span>
        </span>
      `;
    } else {
      row.innerHTML = `
        <span>${item.name} (x${item.quantity})</span>
        <span>${formatCurrency(totalItem)}</span>
      `;
    }
    container.appendChild(row);
  });

  // Reset discount input
  const discountInput = document.getElementById('checkout-discount-input');
  if (discountInput) {
    discountInput.value = 0;
  }

  const taxRate = state.taxRate !== undefined ? state.taxRate : 15;
  const tax = subtotal * (taxRate / 100);
  const grandTotal = subtotal + tax;

  document.getElementById('chk-subtotal').textContent = formatCurrency(subtotal);

  // Hide discount row initially
  const discountRow = document.getElementById('chk-discount-row');
  if (discountRow) {
    discountRow.style.display = 'none';
    document.getElementById('chk-discount').textContent = `-0 ل.س`;
  }

  const labelTax = document.getElementById('chk-tax-label');
  if (labelTax) labelTax.textContent = `الخدمة والضريبة (${taxRate}%):`;

  document.getElementById('chk-tax').textContent = formatCurrency(tax);
  document.getElementById('chk-total').textContent = formatCurrency(grandTotal);

  openModal('modal-checkout');
}

/**
 * Dynamically updates calculations when the cashier enters an invoice-level discount.
 */
function updateCheckoutDiscount() {
  const discountInput = document.getElementById('checkout-discount-input');
  if (!discountInput) return;

  let discount = parseFloat(discountInput.value) || 0;

  // Calculate subtotal excluding hospitality items
  let subtotal = 0;
  state.currentCart.items.forEach(item => {
    const originalTotal = item.price * item.quantity;
    const totalItem = item.isHospitality ? 0 : originalTotal;
    subtotal += totalItem;
  });

  // Enforce discount limits
  if (discount > subtotal) {
    discount = subtotal;
    discountInput.value = subtotal;
  }
  if (discount < 0) {
    discount = 0;
    discountInput.value = 0;
  }

  const netSubtotal = Math.max(0, subtotal - discount);
  const taxRate = state.taxRate !== undefined ? state.taxRate : 15;
  const tax = netSubtotal * (taxRate / 100);
  const grandTotal = netSubtotal + tax;

  const discountRow = document.getElementById('chk-discount-row');
  if (discountRow) {
    if (discount > 0) {
      discountRow.style.display = 'flex';
      document.getElementById('chk-discount').textContent = `-${formatCurrency(discount)}`;
    } else {
      discountRow.style.display = 'none';
    }
  }

  document.getElementById('chk-subtotal').textContent = formatCurrency(subtotal);
  document.getElementById('chk-tax').textContent = formatCurrency(tax);
  document.getElementById('chk-total').textContent = formatCurrency(grandTotal);
}

/**
 * Finalizes the checkout, saves sales history record, and releases the table.
 */
async function executeCheckout() {
  if (!state.selectedTableId) return;
  const table = state.tables.find(t => t.id === state.selectedTableId);
  if (!table) return;

  const pMethod = document.querySelector('input[name="payment-method"]:checked').value;

  // Get discount
  const discountInput = document.getElementById('checkout-discount-input');
  const discount = discountInput ? (parseFloat(discountInput.value) || 0) : 0;

  // Calculate subtotal excluding hospitality items
  let subtotal = 0;
  state.currentCart.items.forEach(item => {
    const originalTotal = item.price * item.quantity;
    const totalItem = item.isHospitality ? 0 : originalTotal;
    subtotal += totalItem;
  });

  const netSubtotal = Math.max(0, subtotal - discount);
  const taxRate = state.taxRate !== undefined ? state.taxRate : 15;
  const tax = netSubtotal * (taxRate / 100);
  const total = netSubtotal + tax;

  // 1. Prepare completed sale payload
  const saleRecord = {
    tableNumber: table.number,
    customerName: state.currentCart.customerName,
    guestCount: state.currentCart.customerCount,
    items: JSON.parse(JSON.stringify(state.currentCart.items)), // Deep copy to preserve isHospitality status
    subtotal: subtotal,
    discount: discount,
    taxRate: taxRate,
    tax: tax,
    total: total,
    paymentMethod: pMethod,
    startTime: state.currentCart.startTime,
    endTime: Date.now()
  };

  // 2. Save in database sales_history
  const invoiceId = await state.db.addSale(saleRecord);

  // 3. Clear active order for this table
  await state.db.clearActiveOrder(state.selectedTableId);

  // 4. Release table back to available
  await state.db.updateTableStatus(state.selectedTableId, 'available');

  // 5. Update UI states and close slide-over
  closeModal('modal-checkout');
  closeOrderSlideOver();

  await refreshStateData();
  renderDashboard();

  // Open reports view and highlight this specific newly created invoice!
  switchTab('reports');
  showReceiptPreview(invoiceId);

  // Auto-print receipt on checkout for 80mm thermal printer
  printReceiptSlipDirectly(saleRecord, invoiceId);
}

// ==========================================================================
// 4. Menu Manager View (CRUD Panels)
// ==========================================================================

function renderMenuManager() {
  renderCategoriesList();
  renderProductsList();
}

// -- Categories CRUD Logic --

function renderCategoriesList() {
  const container = document.getElementById('categories-list');
  if (!container) return;

  container.innerHTML = '';

  // 1. Render static 'All' tab (Not draggable, stays at top)
  const allItem = document.createElement('div');
  allItem.className = `category-item ${state.selectedCategoryFilter === 'all' ? 'active' : ''}`;
  allItem.onclick = () => {
    state.selectedCategoryFilter = 'all';
    renderCategoriesList();
    renderProductsList();
  };
  allItem.innerHTML = `
    <div style="display: flex; align-items: center; gap: 8px;">
      <span>الكل</span>
    </div>
  `;
  container.appendChild(allItem);

  // 2. Render DB Categories (Draggable & sortable)
  state.categories.forEach(cat => {
    const item = document.createElement('div');
    item.className = `category-item draggable-item ${state.selectedCategoryFilter === cat.id ? 'active' : ''}`;
    item.draggable = true;
    item.dataset.id = cat.id;

    item.onclick = () => {
      state.selectedCategoryFilter = cat.id;
      renderCategoriesList();
      renderProductsList();
    };

    item.innerHTML = `
      <div style="display: flex; align-items: center; gap: 8px;">
        <span class="drag-handle" style="color: var(--text-muted); cursor: grab; font-weight: bold; opacity: 0.5; padding: 0 4px;">⋮⋮</span>
        <span>${cat.name}</span>
      </div>
      <div class="category-actions" onclick="event.stopPropagation()">
        <button class="btn-icon-sm edit" onclick="openEditCategoryModal('${cat.id}', '${cat.name}')" title="تعديل">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polygon points="16 3 21 8 8 21 3 21 3 16 16 3"/></svg>
        </button>
        <button class="btn-icon-sm delete" onclick="deleteCategory('${cat.id}')" title="حذف">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>
        </button>
      </div>
    `;

    // HTML5 Drag Event Listeners
    item.addEventListener('dragstart', (e) => {
      e.dataTransfer.setData('text/plain', cat.id);
      item.classList.add('dragging');
    });

    item.addEventListener('dragend', () => {
      item.classList.remove('dragging');
      document.querySelectorAll('.category-item').forEach(el => el.classList.remove('drag-over'));
    });

    item.addEventListener('dragover', (e) => {
      e.preventDefault(); // Crucial to allow dropping
      item.classList.add('drag-over');
    });

    item.addEventListener('dragleave', () => {
      item.classList.remove('drag-over');
    });

    item.addEventListener('drop', async (e) => {
      e.preventDefault();
      item.classList.remove('drag-over');
      const draggedId = e.dataTransfer.getData('text/plain');
      if (draggedId && draggedId !== cat.id) {
        await reorderCategories(draggedId, cat.id);
      }
    });

    container.appendChild(item);
  });
}

/**
 * Handles custom drag and drop reordering of categories in IndexedDB
 */
async function reorderCategories(draggedId, targetId) {
  const draggedIndex = state.categories.findIndex(c => c.id === draggedId);
  const targetIndex = state.categories.findIndex(c => c.id === targetId);

  if (draggedIndex === -1 || targetIndex === -1) return;

  // Reorder in memory array
  const [draggedItem] = state.categories.splice(draggedIndex, 1);
  state.categories.splice(targetIndex, 0, draggedItem);

  // Update sortOrder for all categories based on new index
  for (let i = 0; i < state.categories.length; i++) {
    state.categories[i].sortOrder = i;
    await state.db.saveCategory(state.categories[i]);
  }

  // Refresh memory state and render updated lists
  await refreshStateData();
  renderCategoriesList();

  // Refresh POS slide-over categories as well to keep them in sync
  if (document.getElementById('order-slideover').classList.contains('active')) {
    renderFastCategories();
  }
}

function openAddCategoryModal() {
  document.getElementById('category-form-id').value = '';
  document.getElementById('category-form-name').value = '';
  document.getElementById('category-modal-title').textContent = 'إضافة تصنيف وجبات جديد';
  openModal('modal-category');
}

function openEditCategoryModal(id, name) {
  document.getElementById('category-form-id').value = id;
  document.getElementById('category-form-name').value = name;
  document.getElementById('category-modal-title').textContent = 'تعديل اسم التصنيف';
  openModal('modal-category');
}

async function submitCategoryForm() {
  const id = document.getElementById('category-form-id').value;
  const name = document.getElementById('category-form-name').value.trim();

  if (!name) {
    alert('من فضلك أدخل اسم التصنيف.');
    return;
  }

  const payload = { name };
  if (id) {
    payload.id = id;
    const existing = state.categories.find(c => c.id === id);
    if (existing) payload.sortOrder = existing.sortOrder;
  } else {
    payload.sortOrder = state.categories.length;
  }

  await state.db.saveCategory(payload);
  closeModal('modal-category');
  await refreshStateData();
  renderMenuManager();
}

async function deleteCategory(id) {
  if (confirm('هل أنت متأكد من حذف هذا التصنيف؟ سيتم حذف جميع الأطعمة المرتبطة به تلقائياً!')) {
    await state.db.deleteCategory(id);
    if (state.selectedCategoryFilter === id) {
      state.selectedCategoryFilter = 'all';
    }
    await refreshStateData();
    renderMenuManager();
  }
}

// -- Products CRUD Logic --

function renderProductsList() {
  const container = document.getElementById('products-list');
  if (!container) return;

  container.innerHTML = '';

  const searchVal = document.getElementById('product-search-input').value.toLowerCase().trim();

  // Filter products
  const filtered = state.products.filter(prod => {
    const matchesCategory = state.selectedCategoryFilter === 'all' || prod.categoryId === state.selectedCategoryFilter;
    const matchesSearch = prod.name.toLowerCase().includes(searchVal);
    return matchesCategory && matchesSearch;
  });

  if (filtered.length === 0) {
    container.innerHTML = `<div class="loading-placeholder">لا توجد منتجات مضافة مطابقة للتصفية الحالية.</div>`;
    return;
  }

  filtered.forEach(prod => {
    const catName = state.categories.find(c => c.id === prod.categoryId)?.name || 'غير مصنف';

    const card = document.createElement('div');
    card.className = 'product-card';

    card.innerHTML = `
      <div class="product-card-top">
        <div class="product-category-indicator" style="background-color: ${prod.color || '#d4af37'}"></div>
        <div class="product-meta">
          <h4>${prod.name}</h4>
          <span class="category-label">${catName}</span>
        </div>
      </div>
      
      <div class="product-card-bottom">
        <span class="product-price">${formatCurrency(prod.price)}</span>
        <div class="product-card-actions">
          <button class="btn-icon-sm edit" onclick="openEditProductModal('${prod.id}')" title="تعديل">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polygon points="16 3 21 8 8 21 3 21 3 16 16 3"/></svg>
          </button>
          <button class="btn-icon-sm delete" onclick="deleteProduct('${prod.id}')" title="حذف">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>
          </button>
        </div>
      </div>
    `;

    container.appendChild(card);
  });
}

function filterProductsList() {
  renderProductsList();
}

function populateCategoriesDropdown(dropdownId, selectVal = '') {
  const select = document.getElementById(dropdownId);
  select.innerHTML = '';

  state.categories.forEach(cat => {
    const opt = document.createElement('option');
    opt.value = cat.id;
    opt.textContent = cat.name;
    if (cat.id === selectVal) opt.selected = true;
    select.appendChild(opt);
  });
}

function openAddProductModal() {
  if (state.categories.length === 0) {
    alert('يرجى إنشاء تصنيف واحد على الأقل أولاً قبل إضافة منتج.');
    return;
  }

  document.getElementById('product-form-id').value = '';
  document.getElementById('product-form-name').value = '';
  document.getElementById('product-form-price').value = '';
  populateCategoriesDropdown('product-form-category');

  // Set default color choice
  document.querySelector('input[name="prod-color"][value="#d4af37"]').checked = true;

  document.getElementById('product-modal-title').textContent = 'إضافة وجبة أو منتج للمنيو';
  openModal('modal-product');
}

function openEditProductModal(id) {
  const prod = state.products.find(p => p.id === id);
  if (!prod) return;

  document.getElementById('product-form-id').value = prod.id;
  document.getElementById('product-form-name').value = prod.name;
  document.getElementById('product-form-price').value = prod.price;
  populateCategoriesDropdown('product-form-category', prod.categoryId);

  // Set matching color radio checked
  const radio = document.querySelector(`input[name="prod-color"][value="${prod.color || '#d4af37'}"]`);
  if (radio) radio.checked = true;

  document.getElementById('product-modal-title').textContent = 'تعديل تفاصيل المنتج';
  openModal('modal-product');
}

async function submitProductForm() {
  const id = document.getElementById('product-form-id').value;
  const name = document.getElementById('product-form-name').value.trim();
  const price = parseFloat(document.getElementById('product-form-price').value);
  const categoryId = document.getElementById('product-form-category').value;
  const color = document.querySelector('input[name="prod-color"]:checked').value;

  if (!name || isNaN(price) || price <= 0) {
    alert('يرجى ملء جميع الحقول بشكل صحيح وسعر أكبر من صفر.');
    return;
  }

  const payload = { name, price, categoryId, color };
  if (id) payload.id = id;

  await state.db.saveProduct(payload);
  closeModal('modal-product');
  await refreshStateData();
  renderMenuManager();
}

async function deleteProduct(id) {
  if (confirm('هل أنت متأكد من حذف هذا المنتج نهائياً من المنيو؟')) {
    await state.db.deleteProduct(id);
    await refreshStateData();
    renderMenuManager();
  }
}

// ==========================================================================
// 5. Tables Layout Settings (CRUD)
// ==========================================================================

function renderTablesSettings() {
  const tbody = document.getElementById('tables-settings-list');
  if (!tbody) return;

  tbody.innerHTML = '';

  if (state.tables.length === 0) {
    tbody.innerHTML = `<tr><td colspan="4" class="loading-placeholder">لا توجد طاولات مضافة حالياً.</td></tr>`;
    return;
  }

  state.tables.forEach(tbl => {
    const tr = document.createElement('tr');

    let statusClass = 'available';
    let statusTxt = 'فارغة';
    if (tbl.status === 'occupied') { statusClass = 'occupied'; statusTxt = 'مشغولة'; }
    if (tbl.status === 'billing') { statusClass = 'billing'; statusTxt = 'طلب الفاتورة'; }

    tr.innerHTML = `
      <td><strong>طاولة ${tbl.number}</strong></td>
      <td>${tbl.capacity} أفراد</td>
      <td><span class="badge-status ${statusClass}">${statusTxt}</span></td>
      <td>
        <button class="btn btn-secondary btn-xs" onclick="openEditTableModal('${tbl.id}')" title="تعديل">
          تعديل
        </button>
        <button class="btn btn-danger-outline btn-xs" onclick="deleteTable('${tbl.id}')" title="حذف" style="margin-right: 8px;">
          حذف
        </button>
      </td>
    `;

    tbody.appendChild(tr);
  });
}

function openAddTableModal() {
  document.getElementById('table-form-id').value = '';
  document.getElementById('table-form-number').value = '';
  document.getElementById('table-form-capacity').value = '4';
  document.getElementById('table-modal-title').textContent = 'إضافة طاولة صالة جديدة';
  openModal('modal-table');
}

function openEditTableModal(id) {
  const tbl = state.tables.find(t => t.id === id);
  if (!tbl) return;

  document.getElementById('table-form-id').value = tbl.id;
  document.getElementById('table-form-number').value = tbl.number;
  document.getElementById('table-form-capacity').value = tbl.capacity;
  document.getElementById('table-modal-title').textContent = 'تعديل تفاصيل الطاولة';
  openModal('modal-table');
}

async function submitTableForm() {
  const id = document.getElementById('table-form-id').value;
  const number = document.getElementById('table-form-number').value.trim();
  const capacity = parseInt(document.getElementById('table-form-capacity').value);

  if (!number || isNaN(capacity) || capacity <= 0) {
    alert('يرجى إدخال رقم الطاولة وسعة المقاعد بشكل صحيح.');
    return;
  }

  // Check duplicate table number
  const duplicate = state.tables.find(t => t.number.toLowerCase() === number.toLowerCase() && t.id !== id);
  if (duplicate) {
    alert('عذراً! يوجد طاولة مسجلة بهذا الاسم أو الرقم بالفعل.');
    return;
  }

  const payload = { number, capacity };
  if (id) {
    payload.id = id;
    // Retain status
    payload.status = state.tables.find(t => t.id === id).status;
  }

  await state.db.saveTable(payload);
  closeModal('modal-table');
  await refreshStateData();

  if (state.activeTab === 'tables') renderTablesSettings();
  else renderDashboard();
}

async function deleteTable(id) {
  const tbl = state.tables.find(t => t.id === id);
  if (!tbl) return;

  if (tbl.status !== 'available') {
    alert('لا يمكن حذف طاولة مشغولة أو قيد الحساب حالياً! الرجاء إغلاق الفاتورة أولاً.');
    return;
  }

  if (confirm(`هل أنت متأكد من حذف طاولة رقم ${tbl.number} نهائياً؟`)) {
    await state.db.deleteTable(id);
    await refreshStateData();
    renderTablesSettings();
  }
}

/**
 * Saves general system settings, specifically the custom service and tax rate, to the database.
 */
async function saveSystemSettings() {
  const taxRateInput = document.getElementById('settings-tax-rate');
  if (!taxRateInput) return;

  const taxRateVal = parseFloat(taxRateInput.value);
  if (isNaN(taxRateVal) || taxRateVal < 0 || taxRateVal > 100) {
    alert('يرجى إدخال نسبة ضريبة صالحة بين 0% و 100%.');
    return;
  }

  try {
    await state.db.put('settings', { id: 'tax_rate', value: taxRateVal });
    await refreshStateData();

    // Alert the user with a premium-feeling success message
    alert('تم حفظ إعدادات النظام وتحديث نسبة الضريبة بنجاح.');

    // Refresh active view if dashboard
    if (state.activeTab === 'dashboard') {
      renderDashboard();
    }
  } catch (error) {
    console.error('Failed to save system settings:', error);
    alert('حدث خطأ أثناء حفظ الإعدادات: ' + error.message);
  }
}

/**
 * Updates UI brand elements according to active state settings.
 */
function updateBrandUI() {
  // 1. Update Sidebar Logo
  const sidebarLogoImg = document.querySelector('.brand-logo img');
  if (sidebarLogoImg) {
    sidebarLogoImg.src = state.restaurantLogo || './assets/logo.png';
  }

  // 2. Update Sidebar Title
  const sidebarTitle = document.querySelector('.brand-info h1');
  if (sidebarTitle) {
    sidebarTitle.textContent = `${state.restaurantName || 'Bistro'} POS`;
  }

  // 3. Update Browser Title
  document.title = `${state.restaurantName || 'Bistro'} POS | نظام إدارة المطاعم الذكي`;

  // 4. Update settings form values if they exist in DOM
  const inputName = document.getElementById('settings-brand-name');
  if (inputName) inputName.value = state.restaurantName || 'BISTRO';

  const inputSlogan = document.getElementById('settings-brand-slogan');
  if (inputSlogan) inputSlogan.value = state.restaurantSlogan || 'eatery & Social House';

  const inputFooter = document.getElementById('settings-brand-footer');
  if (inputFooter) inputFooter.value = state.restaurantFooter || 'Bistro POS System By Salem Makoukji';

  const logoPreview = document.getElementById('settings-logo-preview');
  if (logoPreview) logoPreview.src = state.restaurantLogo || './assets/logo.png';

}

/**
 * Toggles visibility of the Firebase inputs container based on check status (Dummy helper for compatibility).
 */
function toggleFirebaseInputsDisplay() { }

/**
 * Handles logo upload, displays local image preview, and buffers it.
 */
let uploadedLogoBase64 = null;

function previewLogoFile(event) {
  const file = event.target.files[0];
  if (!file) return;

  // Verify it's an image
  if (!file.type.startsWith('image/')) {
    alert('يرجى تحديد ملف صورة صالح.');
    return;
  }

  // Standard compression using canvas
  const reader = new FileReader();
  reader.onload = (e) => {
    const img = new Image();
    img.onload = () => {
      const canvas = document.createElement('canvas');
      let width = img.width;
      let height = img.height;

      // Enforce max dimension of 200px to keep Base64 small
      const maxDim = 200;
      if (width > maxDim || height > maxDim) {
        if (width > height) {
          height = Math.round((height * maxDim) / width);
          width = maxDim;
        } else {
          width = Math.round((width * maxDim) / height);
          height = maxDim;
        }
      }

      canvas.width = width;
      canvas.height = height;
      const ctx = canvas.getContext('2d');
      ctx.drawImage(img, 0, 0, width, height);

      // Output as compressed JPEG data URL
      uploadedLogoBase64 = canvas.toDataURL('image/jpeg', 0.8);

      // Update preview immediately
      const preview = document.getElementById('settings-logo-preview');
      if (preview) preview.src = uploadedLogoBase64;
    };
    img.src = e.target.result;
  };
  reader.readAsDataURL(file);
}

/**
 * Saves Cafe Branding settings to database.
 */
async function saveBrandSettings() {
  const nameVal = document.getElementById('settings-brand-name').value.trim() || 'BISTRO';
  const sloganVal = document.getElementById('settings-brand-slogan').value.trim() || 'eatery & Social House';
  const footerVal = document.getElementById('settings-brand-footer').value.trim() || 'Bistro POS System By Salem Makoukji';

  try {
    await state.db.put('settings', { id: 'restaurant_name', value: nameVal });
    await state.db.put('settings', { id: 'restaurant_slogan', value: sloganVal });
    await state.db.put('settings', { id: 'restaurant_footer', value: footerVal });

    if (uploadedLogoBase64) {
      await state.db.put('settings', { id: 'restaurant_logo', value: uploadedLogoBase64 });
      uploadedLogoBase64 = null; // Clear buffer
    }

    await refreshStateData();
    alert('تم حفظ تفاصيل الهوية وتحديث الشعار بنجاح.');
  } catch (error) {
    console.error('Failed to save brand settings:', error);
    alert('حدث خطأ أثناء حفظ تفاصيل الهوية: ' + error.message);
  }
}

// Expose saveSystemSettings and other brand methods globally
window.saveSystemSettings = saveSystemSettings;
window.toggleFirebaseInputsDisplay = toggleFirebaseInputsDisplay;
window.previewLogoFile = previewLogoFile;
window.saveBrandSettings = saveBrandSettings;

// ==========================================================================
// 6. Reports & Sales History Screen
// ==========================================================================

function renderReports() {
  // Get filtered sales list based on state.reportsFilter
  let filteredSales = [...state.salesHistory];
  const todayStr = new Date().toDateString();

  if (state.reportsFilter.type === 'today') {
    filteredSales = state.salesHistory.filter(sale => {
      return new Date(sale.timestamp).toDateString() === todayStr;
    });
  } else if (state.reportsFilter.type === 'custom') {
    const startInput = document.getElementById('rep-start-date')?.value;
    const endInput = document.getElementById('rep-end-date')?.value;

    if (startInput && endInput) {
      const start = new Date(startInput);
      start.setHours(0, 0, 0, 0);
      const end = new Date(endInput);
      end.setHours(23, 59, 59, 999);

      const minTime = Math.min(start.getTime(), end.getTime());
      const maxTime = Math.max(start.getTime(), end.getTime());

      filteredSales = state.salesHistory.filter(sale => {
        return sale.timestamp >= minTime && sale.timestamp <= maxTime;
      });
    }
  }

  // 1. Calculate and render report metrics
  let totalRevenue = 0;
  let totalSalesCount = filteredSales.length;

  filteredSales.forEach(sale => totalRevenue += sale.total);

  const avgTicket = totalSalesCount > 0 ? (totalRevenue / totalSalesCount) : 0;

  document.getElementById('rep-total-sales').textContent = formatCurrency(totalRevenue);
  document.getElementById('rep-total-sales-count').textContent = `من إجمالي ${totalSalesCount} عملية دفع`;
  document.getElementById('rep-avg-ticket').textContent = formatCurrency(avgTicket);

  // Compute popular category
  const categoryTally = {};
  filteredSales.forEach(sale => {
    sale.items.forEach(item => {
      // Find category of item
      const prod = state.products.find(p => p.id === item.productId);
      if (prod) {
        const cat = state.categories.find(c => c.id === prod.categoryId);
        if (cat) {
          categoryTally[cat.name] = (categoryTally[cat.name] || 0) + item.quantity;
        }
      }
    });
  });

  let popularCategory = '-';
  let popularCount = 0;

  Object.keys(categoryTally).forEach(catName => {
    if (categoryTally[catName] > popularCount) {
      popularCount = categoryTally[catName];
      popularCategory = catName;
    }
  });

  document.getElementById('rep-popular-cat').textContent = popularCategory;
  document.getElementById('rep-popular-cat-count').textContent = popularCount > 0 ? `بيع منها ${popularCount} وجبات/مشروبات` : 'الأكثر تفضيلاً للزبائن';

  // 2. Render sales table list
  const tbody = document.getElementById('sales-history-list');
  tbody.innerHTML = '';

  if (filteredSales.length === 0) {
    tbody.innerHTML = `<tr><td colspan="6" class="loading-placeholder">لا توجد عمليات مبيعات مكتملة مسجلة لهذه الفترة.</td></tr>`;
    // Clear receipt preview
    document.getElementById('receipt-preview-container').innerHTML = `
      <div class="placeholder-msg">
        <p>لا توجد فواتير لعرضها.</p>
      </div>`;
    return;
  }

  // Render in reverse chronological order (newest first)
  const reversedSalesList = [...filteredSales].reverse();

  reversedSalesList.forEach(sale => {
    const tr = document.createElement('tr');
    tr.id = `sale-row-${sale.id}`;
    tr.style.cursor = 'pointer';
    tr.onclick = () => showReceiptPreview(sale.id);

    const formattedDate = new Date(sale.timestamp).toLocaleString('ar-SA', {
      month: 'numeric',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit'
    });

    tr.innerHTML = `
      <td><strong>#${sale.id}</strong></td>
      <td>طاولة ${sale.tableNumber}</td>
      <td>${formattedDate}</td>
      <td>${sale.paymentMethod || 'نقداً'}</td>
      <td class="gold-text"><strong>${formatCurrency(sale.total)}</strong></td>
      <td>
        <button class="btn btn-secondary btn-xs" onclick="event.stopPropagation(); showReceiptPreview(${sale.id})">
          استعراض التفاصيل
        </button>
      </td>
    `;

    tbody.appendChild(tr);
  });
}

/**
 * Renders completed sale details inside the right side preview container as an elegant,
 * printable POS slip.
 */
function showReceiptPreview(saleId) {
  // Highlight active row in reports table
  document.querySelectorAll('#sales-history-list tr').forEach(row => row.classList.remove('active'));
  const activeRow = document.getElementById(`sale-row-${saleId}`);
  if (activeRow) activeRow.classList.add('active');

  const sale = state.salesHistory.find(s => s.id === saleId);
  const container = document.getElementById('receipt-preview-container');
  if (!sale || !container) return;

  const formattedInvoiceId = 'Bis-' + String(sale.id).padStart(6, '0');
  const formattedDate = new Date(sale.timestamp).toLocaleString('ar-SA');

  let displayPaymentMethod = 'كاش';
  const rawMethod = String(sale.paymentMethod || '').toLowerCase().trim();
  if (
    rawMethod.includes('card') ||
    rawMethod.includes('credit') ||
    rawMethod.includes('bank') ||
    rawMethod.includes('بنك') ||
    rawMethod.includes('بطاقة') ||
    rawMethod.includes('شبكة') ||
    rawMethod.includes('مدى')
  ) {
    displayPaymentMethod = 'بنك';
  } else {
    displayPaymentMethod = 'كاش';
  }

  // Render Receipt HTML
  let itemsHtml = '';
  sale.items.forEach(item => {
    const originalTotal = item.price * item.quantity;
    if (item.isHospitality) {
      itemsHtml += `
        <tr>
          <td style="padding: 6px 0; text-align: right;">
            ${item.name} <span class="badge-hospitality" style="color: #193B23; background: rgba(25, 59, 35, 0.1); padding: 2px 6px; border-radius: 4px; font-size: 10px; font-weight: bold; margin-right: 4px;">ضيافة</span>
          </td>
          <td style="padding: 6px 0; text-align: center;">${item.quantity}</td>
          <td style="padding: 6px 0; text-align: left;">
            <div style="display: flex; flex-direction: column; align-items: flex-end;">
              <span style="font-size: 11px; text-decoration: line-through; opacity: 0.5; color: #666;">${formatCurrency(originalTotal)}</span>
              <span style="font-weight: bold; color: #193B23;">0 ل.س</span>
            </div>
          </td>
        </tr>
      `;
    } else {
      itemsHtml += `
        <tr>
          <td style="padding: 6px 0; text-align: right;">${item.name}</td>
          <td style="padding: 6px 0; text-align: center;">${item.quantity}</td>
          <td style="padding: 6px 0; text-align: left;">${formatCurrency(originalTotal)}</td>
        </tr>
      `;
    }
  });

  let discountHtml = '';
  if (sale.discount && sale.discount > 0) {
    discountHtml = `
      <div style="display: flex; justify-content: space-between; margin-bottom: 6px; color: #c0392b; font-weight: bold;">
        <span>الحسم الإضافي:</span>
        <span>-${formatCurrency(sale.discount)}</span>
      </div>
    `;
  }

  const taxRate = sale.taxRate !== undefined ? sale.taxRate : 15;

  container.innerHTML = `
    <div style="width: 100%; display:flex; flex-direction:column; align-items:center;">
      <div class="restaurant-receipt" id="printable-receipt-element" style="background: #fff; color: #000; padding: 20px; border-radius: 8px; box-shadow: 0 4px 12px rgba(0,0,0,0.06); width: 100%; max-width: 320px; box-sizing: border-box; font-family: 'Cairo', sans-serif; direction: rtl;">
        <div class="receipt-header" style="text-align: center; margin-bottom: 15px;">
          <img src="${state.restaurantLogo || './assets/logo.png'}" alt="Logo" style="max-height: 50px; margin-bottom: 8px; border-radius: 4px; display: ${state.restaurantLogo ? 'block' : 'none'}; margin-left: auto; margin-right: auto;">
          <h2 style="font-size: 24px; font-weight: 800; margin: 0; color: #000; letter-spacing: 1px;">${state.restaurantName || 'BISTRO'}</h2>
          <p style="font-size: 12px; font-style: italic; margin: 2px 0 0 0; color: #555;">${state.restaurantSlogan || 'eatery & Social House'}</p>
        </div>
        
        <div style="border-top: 1px dashed #000; margin: 10px 0;"></div>
        
        <div class="receipt-details-row" style="display: flex; justify-content: space-between; margin-bottom: 8px; font-size: 13px;">
          <span style="font-weight: 600;">رقم الفاتورة:</span>
          <span style="font-family: monospace; font-weight: bold;">${formattedInvoiceId}</span>
        </div>
        <div class="receipt-details-row" style="display: flex; justify-content: space-between; margin-bottom: 8px; font-size: 13px;">
          <span style="font-weight: 600;">طاولة:</span>
          <span>طاولة ${sale.tableNumber}</span>
        </div>
        <div class="receipt-details-row" style="display: flex; justify-content: space-between; margin-bottom: 8px; font-size: 13px;">
          <span style="font-weight: 600;">الزبون:</span>
          <span>${sale.customerName || 'زبون عام'}</span>
        </div>
        <div class="receipt-details-row" style="display: flex; justify-content: space-between; margin-bottom: 8px; font-size: 13px;">
          <span style="font-weight: 600;">طريقة الدفع:</span>
          <span>${displayPaymentMethod}</span>
        </div>
        <div class="receipt-details-row" style="display: flex; justify-content: space-between; margin-bottom: 8px; font-size: 13px; color: #333;">
          <span style="font-weight: 600;">التاريخ والوقت:</span>
          <span style="font-size: 12px;">${formattedDate}</span>
        </div>
        
        <div style="border-top: 1px dashed #000; margin: 10px 0;"></div>
        
        <table style="width: 100%; border-collapse: collapse; margin: 10px 0; font-size: 13px;">
          <thead>
            <tr>
              <th style="text-align: right; border-bottom: 1px dashed #000; padding-bottom: 6px; width: 55%; font-weight: 700;">الصنف</th>
              <th style="text-align: center; border-bottom: 1px dashed #000; padding-bottom: 6px; width: 15%; font-weight: 700;">العدد</th>
              <th style="text-align: left; border-bottom: 1px dashed #000; padding-bottom: 6px; width: 30%; font-weight: 700;">الإجمالي</th>
            </tr>
          </thead>
          <tbody>
            ${itemsHtml}
          </tbody>
        </table>
        
        <div style="border-top: 1px dashed #000; margin: 10px 0;"></div>
        
        <div class="receipt-totals" style="font-size: 13px; margin-top: 10px;">
          <div style="display: flex; justify-content: space-between; margin-bottom: 6px;">
            <span>المجموع الفرعي:</span>
            <span>${formatCurrency(sale.subtotal)}</span>
          </div>
          ${discountHtml}
          <div style="display: flex; justify-content: space-between; margin-bottom: 6px;">
            <span>الضريبة والخدمة (${taxRate}%):</span>
            <span>${formatCurrency(sale.tax)}</span>
          </div>
          <div class="row grand-total" style="display: flex; justify-content: space-between; font-weight: 800; font-size: 15px; border-top: 1px dashed #000; padding-top: 8px; margin-top: 8px;">
            <span>المجموع النهائي:</span>
            <span>${formatCurrency(sale.total)}</span>
          </div>
        </div>
        
        <div style="border-top: 1px dashed #000; margin: 15px 0 10px 0;"></div>
        
        <div class="receipt-footer" style="text-align: center; margin-top: 10px; font-size: 12px;">
          <p style="font-size: 10px; color: #666; margin: 4px 0 0 0;">${state.restaurantFooter || 'Bistro POS System By Salem Makoukji'}</p>
        </div>
      </div>
      
      <div class="print-receipt-btn-wrapper" style="margin-top: 15px;">
        <button class="btn btn-primary" onclick="printReceiptSlipById(${sale.id})">
          طباعة إيصال الفاتورة
        </button>
      </div>
    </div>
  `;
}

/**
 * Clean iframe-based receipt printing optimized for 80mm thermal receipt printers.
 * Eliminates full-body replacement and page reloads.
 */
function printReceiptSlipDirectly(sale, invoiceId) {
  if (!sale) return;

  const formattedInvoiceId = 'Bis-' + String(invoiceId || sale.id).padStart(6, '0');
  const formattedDate = new Date(sale.timestamp || sale.endTime || Date.now()).toLocaleString('ar-SA');

  let displayPaymentMethod = 'كاش';
  const rawMethod = String(sale.paymentMethod || '').toLowerCase().trim();
  if (
    rawMethod.includes('card') ||
    rawMethod.includes('credit') ||
    rawMethod.includes('bank') ||
    rawMethod.includes('بنك') ||
    rawMethod.includes('بطاقة') ||
    rawMethod.includes('شبكة') ||
    rawMethod.includes('مدى')
  ) {
    displayPaymentMethod = 'بنك';
  } else {
    displayPaymentMethod = 'كاش';
  }

  let itemsHtml = '';
  sale.items.forEach(item => {
    const originalTotal = item.price * item.quantity;
    if (item.isHospitality) {
      itemsHtml += `
        <tr>
          <td style="padding: 1.5mm 0; text-align: right; font-size: 12px; font-weight: bold;">
            ${item.name} <span style="font-size: 10px; font-weight: bold; color: #193B23; border: 1px solid #193B23; padding: 0.2mm 1mm; border-radius: 0.5mm; margin-right: 1mm;">ضيافة</span>
          </td>
          <td style="padding: 1.5mm 0; text-align: center; font-size: 12px;">${item.quantity}</td>
          <td style="padding: 1.5mm 0; text-align: left; font-size: 12px;">
            <div style="display: flex; flex-direction: column; align-items: flex-end;">
              <span style="font-size: 10px; text-decoration: line-through; opacity: 0.5;">${formatCurrency(originalTotal)}</span>
              <span style="font-weight: bold;">0 ل.س</span>
            </div>
          </td>
        </tr>
      `;
    } else {
      itemsHtml += `
        <tr>
          <td style="padding: 1.5mm 0; text-align: right; font-size: 12px; font-weight: bold;">${item.name}</td>
          <td style="padding: 1.5mm 0; text-align: center; font-size: 12px;">${item.quantity}</td>
          <td style="padding: 1.5mm 0; text-align: left; font-size: 12px;">${formatCurrency(originalTotal)}</td>
        </tr>
      `;
    }
  });

  let discountHtml = '';
  if (sale.discount && sale.discount > 0) {
    discountHtml = `
      <div class="row" style="color: #000; font-weight: bold;">
        <span>الحسم الإضافي:</span>
        <span>-${formatCurrency(sale.discount)}</span>
      </div>
    `;
  }

  const taxRate = sale.taxRate !== undefined ? sale.taxRate : 15;

  const iframe = document.createElement('iframe');
  iframe.style.position = 'fixed';
  iframe.style.right = '0';
  iframe.style.bottom = '0';
  iframe.style.width = '0';
  iframe.style.height = '0';
  iframe.style.border = '0';
  document.body.appendChild(iframe);

  const doc = iframe.contentWindow.document;
  doc.open();
  doc.write(`
    <html>
      <head>
        <title>Print Receipt</title>
        <style>
          @import url('https://fonts.googleapis.com/css2?family=Cairo:wght@400;600;700;800&display=swap');
          * {
            box-sizing: border-box;
          }
          @page {
            size: 80mm auto;
            margin: 0;
          }
          body {
            font-family: 'Cairo', sans-serif;
            margin: 0 auto;
            padding: 4mm 8mm 6mm 8mm;
            width: 80mm;
            direction: rtl;
            font-size: 12px;
            color: #000;
            background: #fff;
            -webkit-print-color-adjust: exact;
            print-color-adjust: exact;
          }
          .restaurant-receipt {
            width: 100%;
          }
          .receipt-header {
            text-align: center;
            margin-bottom: 4mm;
          }
          .receipt-header h2 {
            margin: 0;
            font-size: 20px;
            font-weight: 800;
            letter-spacing: 1px;
            color: #000;
          }
          .receipt-header p {
            margin: 2px 0 0 0;
            font-size: 11px;
            font-style: italic;
          }
          .receipt-divider {
            border-top: 1px dashed #000;
            margin: 3mm 0;
            height: 0;
          }
          .receipt-details-row {
            display: flex;
            justify-content: space-between;
            margin-bottom: 2mm;
            font-size: 12px;
          }
          .receipt-details-row span:first-child {
            font-weight: 600;
          }
          .receipt-table {
            width: 100%;
            border-collapse: collapse;
            margin: 3mm 0;
          }
          .receipt-table th {
            border-bottom: 1px dashed #000;
            padding: 2mm 0;
            font-size: 12px;
            font-weight: 700;
          }
          .receipt-table td {
            font-size: 12px;
          }
          .receipt-totals {
            margin-top: 3mm;
            font-size: 12px;
          }
          .receipt-totals .row {
            display: flex;
            justify-content: space-between;
            margin-bottom: 2mm;
          }
          .receipt-totals .row.grand-total {
            font-weight: 800;
            font-size: 14px;
            border-top: 1px dashed #000;
            padding-top: 3mm;
            margin-top: 2mm;
          }
          .receipt-footer {
            text-align: center;
            margin-top: 6mm;
            font-size: 11px;
          }
          .receipt-footer p {
            margin: 3px 0;
          }
        </style>
      </head>
      <body>
        <div class="restaurant-receipt">
          <div class="receipt-header">
            <img src="${state.restaurantLogo || './assets/logo.png'}" alt="Logo" style="max-height: 12mm; margin-bottom: 2mm; border-radius: 1mm; display: ${state.restaurantLogo ? 'block' : 'none'}; margin-left: auto; margin-right: auto;">
            <h2>${state.restaurantName || 'BISTRO'}</h2>
            <p>${state.restaurantSlogan || 'eatery & Social House'}</p>
          </div>
          
          <div class="receipt-divider"></div>
          
          <div class="receipt-details-row">
            <span>رقم الفاتورة:</span>
            <span>${formattedInvoiceId}</span>
          </div>
          <div class="receipt-details-row">
            <span>طاولة:</span>
            <span>طاولة ${sale.tableNumber}</span>
          </div>
          <div class="receipt-details-row">
            <span>الزبون:</span>
            <span>${sale.customerName || 'زبون عام'}</span>
          </div>
          <div class="receipt-details-row">
            <span>طريقة الدفع:</span>
            <span>${displayPaymentMethod}</span>
          </div>
          <div class="receipt-details-row">
            <span>التاريخ والوقت:</span>
            <span>${formattedDate}</span>
          </div>
          
          <div class="receipt-divider"></div>
          
          <table class="receipt-table">
            <thead>
              <tr>
                <th style="text-align: right; width: 55%;">الصنف</th>
                <th style="text-align: center; width: 15%;">العدد</th>
                <th style="text-align: left; width: 30%;">الإجمالي</th>
              </tr>
            </thead>
            <tbody>
              ${itemsHtml}
            </tbody>
          </table>
          
          <div class="receipt-divider"></div>
          
          <div class="receipt-totals">
            <div class="row">
              <span>المجموع الفرعي:</span>
              <span>${formatCurrency(sale.subtotal)}</span>
            </div>
            ${discountHtml}
            <div class="row">
              <span>الضريبة والخدمة (${taxRate}%):</span>
              <span>${formatCurrency(sale.tax)}</span>
            </div>
            <div class="row grand-total">
              <span>المجموع النهائي:</span>
              <span>${formatCurrency(sale.total)}</span>
            </div>
          </div>
          
          <div class="receipt-divider"></div>
          
          <div class="receipt-footer">
            <p style="font-size: 9px; color: #555; margin-top: 4px;">${state.restaurantFooter || 'Bistro POS System By Salem Makoukji'}</p>
          </div>
        </div>
      </body>
    </html>
  `);
  doc.close();

  setTimeout(() => {
    iframe.contentWindow.focus();
    iframe.contentWindow.print();
    setTimeout(() => {
      document.body.removeChild(iframe);
    }, 1500);
  }, 300);
}

function printReceiptSlipById(saleId) {
  const sale = state.salesHistory.find(s => s.id === saleId);
  if (sale) {
    printReceiptSlipDirectly(sale, sale.id);
  }
}

async function confirmClearSalesHistory() {
  if (confirm('تنبيه هام! هل أنت متأكد من رغبتك في حذف سجل المبيعات بالكامل؟ لا يمكن التراجع عن هذا الإجراء.')) {
    await state.db.clearSalesHistory();
    await refreshStateData();
    renderReports();
  }
}

// CSV features removed in favor of full system JSON backup/restore.

// ==========================================================================
// 8. Daily Backup & Full JSON Database Import/Export
// ==========================================================================

/**
 * Checks if a daily backup is needed by looking at localStorage.
 * Displays the alert banner at the top if no backup has been done today.
 */
function checkDailyBackupReminder() {
  const lastBackup = localStorage.getItem('bistro_last_backup_date');
  const dismissedDate = localStorage.getItem('bistro_backup_banner_dismissed_date');
  const todayStr = new Date().toDateString();

  const banner = document.getElementById('daily-backup-banner');
  if (!banner) return;

  // If already backed up today, or dismissed today, hide the banner
  if (lastBackup === todayStr || dismissedDate === todayStr) {
    banner.style.display = 'none';
  } else {
    banner.style.display = 'flex';
  }
}

/**
 * Triggered by the backup button on the daily backup banner.
 * Runs the export and hides the banner upon completion.
 */
async function triggerDailyBackupDownload() {
  await exportFullBackupJSON();
}

/**
 * Dismisses the daily backup warning banner for the rest of today.
 */
function dismissBackupBanner() {
  const todayStr = new Date().toDateString();
  localStorage.setItem('bistro_backup_banner_dismissed_date', todayStr);

  const banner = document.getElementById('daily-backup-banner');
  if (banner) {
    banner.style.display = 'none';
  }
}

/**
 * Exports all IndexedDB stores (tables, categories, products, active_orders, sales_history)
 * as a single JSON file download.
 */
async function exportFullBackupJSON() {
  try {
    if (!state.db) {
      alert('قاعدة البيانات غير جاهزة بعد.');
      return;
    }

    const tables = await state.db.getAll('tables');
    const categories = await state.db.getAll('categories');
    const products = await state.db.getAll('products');
    const activeOrders = await state.db.getAll('active_orders');
    const salesHistory = await state.db.getAll('sales_history');
    const settings = await state.db.getAll('settings');

    const backupData = {
      version: 1.0,
      timestamp: Date.now(),
      tables,
      categories,
      products,
      active_orders: activeOrders,
      sales_history: salesHistory,
      settings
    };

    const jsonString = JSON.stringify(backupData, null, 2);
    const blob = new Blob([jsonString], { type: 'application/json;charset=utf-8;' });
    const todayStr = new Date().toISOString().slice(0, 10);

    const link = document.createElement("a");
    const url = URL.createObjectURL(blob);
    link.setAttribute("href", url);
    link.setAttribute("download", `bistro_full_backup_${todayStr}.json`);
    link.style.visibility = 'hidden';
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);

    // Save backup date to stop showing reminder banner today
    const todayStrDate = new Date().toDateString();
    localStorage.setItem('bistro_last_backup_date', todayStrDate);

    const banner = document.getElementById('daily-backup-banner');
    if (banner) banner.style.display = 'none';

    alert('تم تصدير النسخة الاحتياطية الكاملة للنظام بنجاح.');
  } catch (error) {
    console.error('Full backup export failed:', error);
    alert('حدث خطأ أثناء تصدير النسخة الاحتياطية الكاملة: ' + error.message);
  }
}

/**
 * Triggers the file dialog for full database JSON import.
 */
function triggerFullBackupImport() {
  const fileInput = document.getElementById('backup-import-input');
  if (fileInput) fileInput.click();
}

/**
 * Handles parsing and restoring the JSON backup file into IndexedDB.
 * Clears current tables, categories, products, active_orders, and sales_history,
 * populates them, and refreshes the application.
 */
async function handleFullBackupImport(event) {
  const file = event.target.files[0];
  if (!file) return;

  const confirmMsg = 'تنبيه هام جداً!\n\nاستعادة النسخة الاحتياطية الكاملة سيقوم بمسح وحذف كافة البيانات الحالية في النظام (طاولات، منيو، فواتير مدفوعة، مبيعات) واستبدالها بالكامل ببيانات ملف النسخة الاحتياطية.\n\nهل أنت متأكد تماماً وتريد الاستمرار؟';
  if (!confirm(confirmMsg)) {
    event.target.value = '';
    return;
  }

  const reader = new FileReader();
  reader.onload = async (e) => {
    try {
      const backupData = JSON.parse(e.target.result);

      // Validate schema minimally
      if (!backupData || !Array.isArray(backupData.tables) || !Array.isArray(backupData.categories) || !Array.isArray(backupData.products)) {
        alert('ملف النسخة الاحتياطية غير صالح أو تالف. يرجى التأكد من اختيار ملف .json الصحيح المصدّر من هذا النظام.');
        event.target.value = '';
        return;
      }

      // 1. Clear existing database stores completely
      await state.db.clearStore('tables');
      await state.db.clearStore('categories');
      await state.db.clearStore('products');
      await state.db.clearStore('active_orders');
      await state.db.clearStore('sales_history');
      await state.db.clearStore('settings');

      // 2. Insert tables
      for (const tbl of backupData.tables) {
        await state.db.put('tables', tbl);
      }

      // 3. Insert categories
      for (const cat of backupData.categories) {
        await state.db.put('categories', cat);
      }

      // 4. Insert products
      for (const prod of backupData.products) {
        await state.db.put('products', prod);
      }

      // 5. Insert active orders (if any exist in backup)
      if (Array.isArray(backupData.active_orders)) {
        for (const ord of backupData.active_orders) {
          await state.db.put('active_orders', ord);
        }
      }

      // 6. Insert sales history (if any exist in backup)
      if (Array.isArray(backupData.sales_history)) {
        for (const sale of backupData.sales_history) {
          await state.db.put('sales_history', sale);
        }
      }

      // 7. Insert settings (if any exist in backup)
      if (Array.isArray(backupData.settings)) {
        for (const set of backupData.settings) {
          await state.db.put('settings', set);
        }
      }

      alert('تم استيراد واستعادة النسخة الاحتياطية بنجاح! سيتم الآن إعادة تحميل النظام لتطبيق التغييرات.');
      window.location.reload();

    } catch (error) {
      console.error('Full backup import failed:', error);
      alert('فشل استيراد النسخة الاحتياطية: تأكد من أن الملف بصيغة JSON صحيحة وغير تالف.');
    } finally {
      event.target.value = '';
    }
  };

  reader.readAsText(file, "UTF-8");
}

// Expose new daily backup functions to window explicitly
window.checkDailyBackupReminder = checkDailyBackupReminder;
window.triggerDailyBackupDownload = triggerDailyBackupDownload;
window.dismissBackupBanner = dismissBackupBanner;
window.exportFullBackupJSON = exportFullBackupJSON;
window.triggerFullBackupImport = triggerFullBackupImport;
window.handleFullBackupImport = handleFullBackupImport;

/**
 * Sets the filter type for the sales reports (all, today, custom).
 */
function setReportsFilter(filterType) {
  state.reportsFilter.type = filterType;

  // 1. Update filter buttons UI
  document.querySelectorAll('.reports-filter-bar .filter-btn').forEach(btn => {
    btn.classList.remove('active');
  });

  const activeBtn = document.getElementById(`btn-rep-filter-${filterType}`);
  if (activeBtn) activeBtn.classList.add('active');

  const dateInputs = document.getElementById('reports-date-inputs');

  // 2. Toggle date inputs display
  if (filterType === 'custom') {
    if (dateInputs) {
      dateInputs.style.display = 'flex';

      // Default both inputs to today's date if empty
      const todayIso = new Date().toISOString().slice(0, 10);
      const startEl = document.getElementById('rep-start-date');
      const endEl = document.getElementById('rep-end-date');

      if (startEl && !startEl.value) startEl.value = todayIso;
      if (endEl && !endEl.value) endEl.value = todayIso;
    }
    renderReports();
  } else {
    if (dateInputs) dateInputs.style.display = 'none';
    renderReports();
  }
}

/**
 * Triggered when custom date inputs are modified.
 */
function applyCustomDateFilter() {
  if (state.reportsFilter.type === 'custom') {
    renderReports();
  }
}

// Expose new reports filtering functions globally
window.setReportsFilter = setReportsFilter;
window.applyCustomDateFilter = applyCustomDateFilter;
