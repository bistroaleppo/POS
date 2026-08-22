// Detects whether the app is running inside the Electron desktop build (exe).
const isElectron = !!(typeof window !== 'undefined' && window.bistroPrint && window.bistroPrint.isElectron);

// Global Application State
const state = {
  db: null,
  tables: [],
  categories: [],
  products: [],
  salesHistory: [],
  reservations: [],
  printers: [],
  activeOrders: {},    // In-memory cache of active orders keyed by tableId for instant dashboard rendering

  // Deep snapshot (per table) of items as last SAVED/printed. Used to detect
  // cancellations/reductions reliably even after the cart has been edited or
  // the user switched tables and came back (protects the "before" state).
  lastSavedItems: {},

  // Selections
  activeTab: 'dashboard',
  selectedTableId: null,
  selectedCategoryFilter: 'all', // For menu manager
  selectedFastCategoryFilter: 'all', // For slide-over quick picker
  activeTableFilter: 'all', // For dashboard tables grid
  activeReservationFilter: 'all',
  activeReservationDateFilter: 'today',
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
  const val = Math.round(amount || 0);
  const newLira = val.toLocaleString('en-US');
  return `${newLira} ل.س`;
}

/**
 * Saves a lightweight snapshot of essential app state to localStorage so the
 * app can hydrate instantly (0ms) on next launch before network calls finish.
 * Sales history is capped to the most recent 100 records to respect quota.
 */
function saveFastCache() {
  try {
    localStorage.setItem('bistro_fast_cache', JSON.stringify({
      tables: state.tables || [],
      activeOrders: state.activeOrders || {},
      categories: state.categories || [],
      products: state.products || [],
      salesHistory: (state.salesHistory || []).slice(0, 100),
      reservations: state.reservations || [],
      printers: state.printers || [],
      taxRate: state.taxRate,
      restaurantName: state.restaurantName,
      restaurantSlogan: state.restaurantSlogan,
      restaurantLogo: state.restaurantLogo,
      restaurantFooter: state.restaurantFooter
    }));
  } catch (e) {
    console.warn('Fast cache save skipped (storage quota or unavailable):', e);
  }
}

// ==========================================================================
// Initialization & Startup
// ==========================================================================

// ==========================================================================
// AUTHENTICATION FLOW
// ==========================================================================
async function handleLoginSubmit(e) {
  e.preventDefault();

  const email = document.getElementById('email-input').value.trim();
  const password = document.getElementById('password-input').value.trim();
  const errorContainer = document.getElementById('login-error-container');
  const loginBtn = document.getElementById('btn-login-text');

  errorContainer.style.display = 'none';
  loginBtn.textContent = 'جاري التحقق والدخول...';
  loginBtn.style.opacity = '0.7';
  loginBtn.disabled = true;

  try {
    try {
      await firebase.auth().setPersistence(firebase.auth.Auth.Persistence.LOCAL);
    } catch (pErr) {
      console.warn('Set persistence warning:', pErr);
    }

    const authPromise = firebase.auth().signInWithEmailAndPassword(email, password);
    const timeoutPromise = new Promise((resolve) => setTimeout(() => resolve('timeout'), 3500));

    const result = await Promise.race([authPromise, timeoutPromise]);
    if (result === 'timeout') {
      console.warn('Firebase auth network taking >3.5s, activating local session immediately...');
    }

    localStorage.setItem('bistro_auth_active', 'true');
    localStorage.setItem('bistro_auth_email', email);

    document.getElementById('login-container').style.display = 'none';
    document.getElementById('app-container').style.display = 'flex';
    if (typeof setupLoggedInSession === 'function') {
      setupLoggedInSession({ email });
    } else {
      renderDashboard();
    }
  } catch (err) {
    if (err.code === 'auth/network-request-failed' || !navigator.onLine) {
      localStorage.setItem('bistro_auth_active', 'true');
      document.getElementById('login-container').style.display = 'none';
      document.getElementById('app-container').style.display = 'flex';
      renderDashboard();
      return;
    }
    console.error('Login failed:', err);
    errorContainer.style.display = 'flex';
    document.getElementById('password-input').value = '';
    loginBtn.textContent = 'تسجيل الدخول';
    loginBtn.style.opacity = '1';
    loginBtn.disabled = false;

    errorContainer.style.animation = 'none';
    errorContainer.offsetHeight; /* trigger reflow */
    errorContainer.style.animation = 'shake 0.5s ease';
  }
}

async function handleLogout() {
  localStorage.removeItem('bistro_auth_active');
  localStorage.removeItem('bistro_auth_email');
  try {
    await firebase.auth().signOut();
  } catch (err) {
    console.error('Logout failed:', err);
  }
  window.location.reload();
}

document.addEventListener('DOMContentLoaded', async () => {
  // Prevent Electron input freezes by ensuring click focus
  if (isElectron) {
    document.addEventListener('mousedown', (e) => {
      if (['INPUT', 'SELECT', 'TEXTAREA'].includes(e.target.tagName)) {
        e.target.focus();
      }
    });
  }

  try {
    // 0. Warn when running from file:// (blocks WebUSB + offline caching)
    if (window.location && window.location.protocol === 'file:' && !isElectron) {
      console.warn('Bistro POS running from file://. Serve over HTTP(S) (e.g. http://localhost) for WebUSB pairing and offline mode.');
      const notice = document.getElementById('file-protocol-notice');
      if (notice) notice.style.display = 'block';
    }

    // 0.5 Electron build: no separate bridge server needed - printing is done directly via IPC
    if (isElectron) {
      console.log('Bistro POS is running as a desktop app (Electron). Direct printing enabled.');
      const bridgeBox = document.getElementById('print-bridge-settings-box');
      if (bridgeBox) bridgeBox.style.display = 'none';
      const bridgeNote = document.getElementById('print-bridge-electron-note');
      if (bridgeNote) bridgeNote.style.display = 'block';
    }

    // 1. Start clock widget immediately so UI is alive
    initClock();

    // 2. Hook up window-level events
    setupGlobalEventListeners();

    if (!firebase.apps.length) {
      // Need firebaseConfig from database.js
      firebase.initializeApp(firebaseConfig);
    }

    try {
      await firebase.auth().setPersistence(firebase.auth.Auth.Persistence.LOCAL);
    } catch (pErr) {
      console.warn('Set persistence warning:', pErr);
    }

    let authInitialized = false;

    const setupLoggedInSession = async (user) => {
      if (authInitialized) return;
      authInitialized = true;

      localStorage.setItem('bistro_auth_active', 'true');
      if (user && user.email) {
        localStorage.setItem('bistro_auth_email', user.email);
      }

      document.getElementById('login-container').style.display = 'none';
      document.getElementById('app-container').style.display = 'flex';

      // 3. Render default tab and setup shell
      switchTab('dashboard');

      // 3.5 Instantly hydrate from fast local cache BEFORE database network calls (0ms launch speed)
      try {
        const rawFastCache = localStorage.getItem('bistro_fast_cache');
        if (rawFastCache) {
          const fastCache = JSON.parse(rawFastCache);
          if (fastCache.tables && fastCache.tables.length) state.tables = fastCache.tables;
          if (fastCache.activeOrders) state.activeOrders = fastCache.activeOrders;
          if (fastCache.categories && fastCache.categories.length) state.categories = fastCache.categories;
          if (fastCache.products && fastCache.products.length) state.products = fastCache.products;
          if (fastCache.salesHistory) state.salesHistory = fastCache.salesHistory;
          if (fastCache.reservations) state.reservations = fastCache.reservations;
          if (fastCache.printers) state.printers = fastCache.printers;
          if (fastCache.taxRate) state.taxRate = fastCache.taxRate;
          if (fastCache.restaurantName) state.restaurantName = fastCache.restaurantName;
          if (fastCache.restaurantSlogan) state.restaurantSlogan = fastCache.restaurantSlogan;
          if (fastCache.restaurantLogo) state.restaurantLogo = fastCache.restaurantLogo;
          if (fastCache.restaurantFooter) state.restaurantFooter = fastCache.restaurantFooter;

          // Render dashboard immediately in 0.001 seconds!
          renderDashboard();
          updateBrandUI();
          updateGlobalStatsUI();
        }
      } catch (e) {
        console.warn('Fast cache hydration note:', e);
      }

      // 4. Initialize Firebase database connection
      state.db = new BistroDatabase();
      const isConfigured = await state.db.init();

      if (!isConfigured) {
        alert('لم يتم إعداد قاعدة بيانات Firebase بعد أو فشل الاتصال بها. يرجى إدخال إعدادات الاتصال الصحيحة داخل ملف database.js لتشغيل المزامنة السحابية.');
      } else {
        // 5. Seed data asynchronously in background (non-blocking)
        state.db.seedIfEmpty().catch(err => console.warn('Background seed check note:', err));
      }

      // 6. Load initial data from DB into state non-blockingly
      refreshStateData().catch(err => console.warn('Background refresh note:', err));

      // 6.1 Attach real-time listeners for Tables, Active Orders, Menu & Settings for instant live sync
      try {
        if (state.db && state.db.firestore) {
          console.log('Attaching realtime sync listeners for tables, orders, menu & settings...');

          // Realtime Tables Sync (Instant 0ms cache + live cloud sync)
          state.db.firestore.collection('tables').onSnapshot(snapshot => {
            const tables = [];
            snapshot.forEach(doc => tables.push({ id: doc.id, ...doc.data() }));
            if (tables.length > 0) {
              state.tables = tables;
              state.tables.sort((a, b) => (a.sortOrder || 0) - (b.sortOrder || 0));
              saveFastCache();
              renderDashboard();
            }
          }, err => console.warn('Tables realtime sync note:', err));

          // Realtime Active Orders Sync
          state.db.firestore.collection('active_orders').onSnapshot(snapshot => {
            const activeOrdersMap = {};
            snapshot.forEach(doc => {
              const ord = doc.data();
              if (ord && ord.tableId) activeOrdersMap[ord.tableId] = { id: doc.id, ...ord };
            });
            state.activeOrders = activeOrdersMap;
            saveFastCache();
            renderDashboard();
          }, err => console.warn('Active orders realtime sync note:', err));

          // Realtime Categories Sync
          state.db.firestore.collection('categories').onSnapshot(snapshot => {
            const cats = [];
            snapshot.forEach(doc => cats.push({ id: doc.id, ...doc.data() }));
            if (cats.length > 0) {
              state.categories = cats;
              state.categories.sort((a, b) => (a.sortOrder || 0) - (b.sortOrder || 0));
              saveFastCache();
            }
          }, err => console.warn('Categories realtime sync note:', err));

          // Realtime Products Sync
          state.db.firestore.collection('products').onSnapshot(snapshot => {
            const prods = [];
            snapshot.forEach(doc => prods.push({ id: doc.id, ...doc.data() }));
            if (prods.length > 0) {
              state.products = prods;
              saveFastCache();
            }
          }, err => console.warn('Products realtime sync note:', err));

          // Realtime Settings Sync
          state.db.firestore.collection('settings').onSnapshot(snapshot => {
            const settings = [];
            snapshot.forEach(doc => settings.push({ id: doc.id, ...doc.data() }));

            const taxRateSetting = settings.find(s => s.id === 'tax_rate');
            if (taxRateSetting) state.taxRate = parseFloat(taxRateSetting.value);

            const brandNameSetting = settings.find(s => s.id === 'restaurant_name');
            if (brandNameSetting) state.restaurantName = brandNameSetting.value;

            const brandSloganSetting = settings.find(s => s.id === 'restaurant_slogan');
            if (brandSloganSetting) state.restaurantSlogan = brandSloganSetting.value;

            const brandLogoSetting = settings.find(s => s.id === 'restaurant_logo');
            if (brandLogoSetting) state.restaurantLogo = brandLogoSetting.value;

            const brandFooterSetting = settings.find(s => s.id === 'restaurant_footer');
            if (brandFooterSetting) state.restaurantFooter = brandFooterSetting.value;

            const printBridgeSetting = settings.find(s => s.id === 'print_bridge_url');
            if (printBridgeSetting) state.printBridgeUrl = printBridgeSetting.value;

            const bridgeInput = document.getElementById('settings-print-bridge-url');
            if (bridgeInput) bridgeInput.value = state.printBridgeUrl || '';
            updateBrandUI();
            updateGlobalStatsUI();
          }, err => console.error('Settings realtime listener failed:', err));
        }
      } catch (err) {
        console.warn('Could not attach realtime listeners:', err);
      }

      // 7. Render dashboard immediately
      renderDashboard();

      // 8. Check Daily Backup Warning
      checkDailyBackupReminder();

      console.log('POS initialized successfully with realtime live sync.');
    };

    firebase.auth().onAuthStateChanged(async (user) => {
      if (user) {
        await setupLoggedInSession(user);
      } else {
        // Fallback for Electron & Offline sessions: if user previously logged in, maintain persistent session across app restarts
        const isLocallyActive = localStorage.getItem('bistro_auth_active') === 'true';
        if (isLocallyActive) {
          await setupLoggedInSession(null);
        } else {
          document.getElementById('login-container').style.display = 'flex';
          document.getElementById('app-container').style.display = 'none';
        }
      }
    });

  } catch (error) {
    console.error('Initialization failed:', error);
    alert('حدث خطأ أثناء تحميل قاعدة البيانات. يرجى التحقق من إعدادات Firebase والاتصال بالإنترنت.');
  }
});

/**
 * Refreshes local state arrays from database.
 */
async function refreshStateData(options = {}) {
  if (!state.db) return;

  const loadAll = Object.keys(options).length === 0;
  const promises = [];

  if (loadAll || options.tables || !state.tables || state.tables.length === 0) {
    promises.push(state.db.getTables().then(res => {
      state.tables = res;
      state.tables.sort((a, b) => (a.sortOrder || 0) - (b.sortOrder || 0));
    }));
  }

  if (loadAll) {
    promises.push(
      state.db.getAll('active_orders').then(activeOrdersList => {
        state.activeOrders = {};
        activeOrdersList.forEach(ord => { if (ord && ord.tableId) state.activeOrders[ord.tableId] = ord; });
      }).catch(err => {
        state.activeOrders = state.activeOrders || {};
      })
    );
  }

  if (options.menu || !state.categories || state.categories.length === 0) {
    promises.push(state.db.getCategories().then(res => {
      state.categories = res;
      state.categories.sort((a, b) => (a.sortOrder || 0) - (b.sortOrder || 0));
    }));
  }

  if (options.menu || !state.products || state.products.length === 0) {
    promises.push(state.db.getProducts().then(res => state.products = res));
  }

  if (options.sales || !state.salesHistory || state.salesHistory.length === 0) {
    promises.push(state.db.getSalesHistory(false).then(res => state.salesHistory = res));
  }

  if (options.reservations || !state.reservations || state.reservations.length === 0) {
    promises.push(state.db.getReservations().then(res => {
      state.reservations = res;
      state.reservations.sort((a, b) => {
        const dateTimeA = new Date((a.reservationDate || '') + 'T' + (a.reservationTime || '00:00'));
        const dateTimeB = new Date((b.reservationDate || '') + 'T' + (b.reservationTime || '00:00'));
        return dateTimeA - dateTimeB;
      });
    }));
  }

  if (options.printers || !state.printers || state.printers.length === 0) {
    promises.push(state.db.getPrinters().then(res => {
      state.printers = res || [];
    }));
  }

  if (options.settings || state.taxRate === undefined) {
    promises.push(
      state.db.getAll('settings', !!options.settings).then(settings => {
        const taxRateSetting = settings.find(s => s.id === 'tax_rate');
        state.taxRate = taxRateSetting ? parseFloat(taxRateSetting.value) : 15;

        const brandNameSetting = settings.find(s => s.id === 'restaurant_name');
        state.restaurantName = brandNameSetting ? brandNameSetting.value : 'Restaurant';

        const brandSloganSetting = settings.find(s => s.id === 'restaurant_slogan');
        state.restaurantSlogan = brandSloganSetting ? brandSloganSetting.value : 'Welcome';

        const brandLogoSetting = settings.find(s => s.id === 'restaurant_logo');
        state.brandLogo = brandLogoSetting ? brandLogoSetting.value : './assets/logo.png';

        const brandFooterSetting = settings.find(s => s.id === 'restaurant_footer');
        state.restaurantFooter = brandFooterSetting ? brandFooterSetting.value : 'Have a nice day!';

        const printBridgeSetting = settings.find(s => s.id === 'print_bridge_url');
        state.printBridgeUrl = printBridgeSetting ? printBridgeSetting.value : 'http://localhost:6333';
      }).catch(err => {
        console.error('Failed to load settings from DB. Applying defaults:', err);
        state.taxRate = 15;
        state.restaurantName = 'Restaurant';
        state.restaurantSlogan = 'Welcome';
        state.restaurantLogo = './assets/logo.png';
        state.restaurantFooter = 'Have a nice day!';
        state.printBridgeUrl = 'http://localhost:6333';
      })
    );
  }

  await Promise.allSettled(promises);

  // Save fast local storage snapshot for instant app launch next time
  saveFastCache();

  // Populate UI inputs with settings values
  const taxRateInput = document.getElementById('settings-tax-rate');
  if (taxRateInput) {
    taxRateInput.value = state.taxRate;
  }

  const bridgeInput = document.getElementById('settings-print-bridge-url');
  if (bridgeInput) {
    bridgeInput.value = state.printBridgeUrl || '';
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
    timeDisplay.textContent = now.toLocaleTimeString('ar-SY', {
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

async function switchTab(tabId) {
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
      await renderDashboard();
      break;
    case 'menu':
      tabTitle.textContent = 'قائمة الطعام';
      tabDesc.textContent = 'إدارة وتعديل أطعمة ومشروبات المطعم، إضافة منتجات جديدة أو تصنيفات.';
      await refreshStateData({ menu: true });
      renderMenuManager();
      break;
    case 'tables':
      tabTitle.textContent = 'إدارة طاولات الصالة';
      tabDesc.textContent = 'إضافة وتعديل طاولات المطعم وسعتها المقعدية.';
      await refreshStateData({ tables: true, printers: true });
      renderTablesSettings();
      renderPrintersList();
      break;
    case 'reports':
      tabTitle.textContent = 'الفواتير والتقارير المالية';
      tabDesc.textContent = 'مراجعة المبيعات الإجمالية اليومية، واستعراض فواتير الدفع المكتملة.';
      // Always refresh sales from the server so reports show the COMPLETE dataset
      // (never trust a stale/partial cache, e.g. the 100-sale fast-launch snapshot).
      const repTbody = document.getElementById('sales-history-list');
      if (repTbody) repTbody.innerHTML = `<tr><td colspan="6" class="loading-placeholder">جاري جلب كامل سجل المبيعات من السحابة...</td></tr>`;
      await refreshStateData({ sales: true });
      renderReports();
      break;
    case 'reservations':
      tabTitle.textContent = 'حجز الطاولات';
      tabDesc.textContent = 'إدارة الحجوزات المسبقة للطاولات وتنسيق حضور وجلوس الزبائن.';
      await refreshStateData({ reservations: true });
      renderReservations();
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

// Pure synchronous render - reads only from state (zero DB calls, zero latency).
function renderDashboard() {
  const gridContainer = document.getElementById('tables-grid-container');
  if (!gridContainer) return;

  gridContainer.innerHTML = '';

  const filteredTables = state.tables.filter(tbl => {
    if (state.activeTableFilter === 'all') return true;
    return tbl.status === state.activeTableFilter;
  });

  if (filteredTables.length === 0) {
    gridContainer.innerHTML = `<div class="loading-placeholder">لا توجد طاولات تطابق التصفية الحالية.</div>`;
    return;
  }

  const activeOrdersMap = state.activeOrders || {};

  for (const tbl of filteredTables) {
    const card = document.createElement('div');
    card.className = `table-card ${tbl.status}`;
    card.onclick = () => openOrderSlideOver(tbl.id);

    let orderAmountHtml = '';
    let timeElapsedHtml = '';

    if (tbl.status !== 'available') {
      const activeOrder = activeOrdersMap[tbl.id];
      if (activeOrder && activeOrder.items && activeOrder.items.length > 0) {
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

function openOrderSlideOver(tableId) {
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

    // Load Active Order from in-memory state (no DB call needed)
    const activeOrder = (state.activeOrders || {})[tableId];
    if (activeOrder) {
      // IMPORTANT: decouple the editable cart from the stored order. If we
      // reused the same array/objects, editing the cart would mutate the saved
      // order and the "before" state would be lost (breaking cancellation prints).
      state.currentCart.items = JSON.parse(JSON.stringify(activeOrder.items || []));
      state.lastSavedItems[tableId] = JSON.parse(JSON.stringify(activeOrder.items || []));
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

  const newOrder = {
    tableId: state.selectedTableId,
    items: [],
    customerName: customerName,
    customerCount: customerCount,
    startTime: Date.now()
  };

  // 1. Optimistic state update - update memory FIRST for instant UI response
  const table = state.tables.find(t => t.id === state.selectedTableId);
  if (table) table.status = 'occupied';
  if (!state.activeOrders) state.activeOrders = {};
  state.activeOrders[state.selectedTableId] = newOrder;
  state.currentCart.items = [];
  state.currentCart.customerName = customerName;
  state.currentCart.customerCount = customerCount;
  state.currentCart.startTime = newOrder.startTime;
  state.lastSavedItems[state.selectedTableId] = [];

  // 2. Open the occupied panel immediately - no DB wait
  openOrderSlideOver(state.selectedTableId);

  // 3. Fire DB writes in background - non-blocking
  state.db.saveActiveOrder(state.selectedTableId, newOrder).catch(err =>
    console.error('Background save active order failed:', err)
  );
  state.db.updateTableStatus(state.selectedTableId, 'occupied').catch(err =>
    console.error('Background update table status failed:', err)
  );
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
    document.getElementById('calc-total').textContent = formatCurrency(0);
    document.getElementById('cart-items-count').textContent = '0 عناصر';

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

  // Math Calculations (no tax)
  const total = subtotal;

  document.getElementById('calc-subtotal').textContent = formatCurrency(subtotal);
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

  // 1. Update in-memory state immediately
  const activeOrder = (state.activeOrders || {})[state.selectedTableId];
  if (activeOrder) {
    // Compare against the last SAVED snapshot (not the live order which may
    // have been mutated), so cancellations/reductions are always detected.
    const savedItems = state.lastSavedItems[state.selectedTableId] !== undefined
      ? state.lastSavedItems[state.selectedTableId]
      : (activeOrder.items || []);
    const oldItems = JSON.parse(JSON.stringify(savedItems));
    const newItems = [...state.currentCart.items];

    // Detect and print cancellation tickets for any previously printed items that were canceled or reduced
    const canceledList = await detectAndPrintCanceledItems(state.selectedTableId, oldItems, JSON.parse(JSON.stringify(newItems)));

    // The canceled units are no longer "active printed" quantities - sync printedQty
    // so a later reduction computes the correct remaining delta (no double-counting).
    canceledList.forEach(c => {
      const n = newItems.find(i => i.productId === c.productId);
      if (n) n.printedQty = n.quantity;
    });

    activeOrder.items = newItems;

    // 1.5 Auto-print kitchen tickets for newly added items only
    await printKitchenAuto();

    // Persist the new saved snapshot for the next modification
    state.lastSavedItems[state.selectedTableId] = JSON.parse(JSON.stringify(activeOrder.items));

    const table = state.tables.find(t => t.id === state.selectedTableId);
    if (table && table.status === 'billing') {
      table.status = 'occupied';
    }

    // 2. Close slideover immediately - renderDashboard is now instant
    closeOrderSlideOver();

    // 3. Fire DB writes in background - non-blocking
    state.db.saveActiveOrder(state.selectedTableId, activeOrder).catch(err =>
      console.error('Background save order failed:', err)
    );
    if (table && table.status === 'occupied') {
      state.db.updateTableStatus(state.selectedTableId, 'occupied').catch(err =>
        console.error('Background update table status failed:', err)
      );
    }
  } else {
    closeOrderSlideOver();
  }
}

/**
 * Changes table status to Yellow billing mode.
 */
async function markTableForBilling() {
  if (!state.selectedTableId) return;

  // 1. Update in-memory state immediately
  const activeOrder = (state.activeOrders || {})[state.selectedTableId];
  if (activeOrder) {
    const savedItems = state.lastSavedItems[state.selectedTableId] !== undefined
      ? state.lastSavedItems[state.selectedTableId]
      : (activeOrder.items || []);
    const oldItems = JSON.parse(JSON.stringify(savedItems));
    const newItems = [...state.currentCart.items];

    const canceledList = await detectAndPrintCanceledItems(state.selectedTableId, oldItems, JSON.parse(JSON.stringify(newItems)));
    canceledList.forEach(c => {
      const n = newItems.find(i => i.productId === c.productId);
      if (n) n.printedQty = n.quantity;
    });

    activeOrder.items = newItems;

    // Auto-print kitchen tickets for any newly added items before billing
    await printKitchenAuto();

    state.lastSavedItems[state.selectedTableId] = JSON.parse(JSON.stringify(activeOrder.items));
  }

  const table = state.tables.find(t => t.id === state.selectedTableId);
  if (table) table.status = 'billing';

  // 2. Close slideover immediately
  closeOrderSlideOver();

  // 3. Fire DB writes in background - non-blocking
  if (activeOrder) {
    state.db.saveActiveOrder(state.selectedTableId, activeOrder).catch(err =>
      console.error('Background save billing order failed:', err)
    );
  }
  state.db.updateTableStatus(state.selectedTableId, 'billing').catch(err =>
    console.error('Background update billing status failed:', err)
  );
}

/**
 * Opens the move-table modal and populates it with available (empty) tables.
 */
function openMoveTableModal() {
  if (!state.selectedTableId) return;

  // Persist the current cart into the active order before moving
  const activeOrder = (state.activeOrders || {})[state.selectedTableId];
  if (activeOrder) activeOrder.items = [...state.currentCart.items];

  const available = (state.tables || []).filter(t => t.id !== state.selectedTableId && t.status === 'available');
  const select = document.getElementById('move-table-select');
  if (!select) return;

  if (available.length === 0) {
    alert('لا توجد طاولات فارغة لنقل الطلب إليها. أفرغ طاولة أولاً أو أضف طاولة جديدة من إدارة الطاولات.');
    return;
  }

  select.innerHTML = available
    .map(t => `<option value="${t.id}">طاولة ${t.number} (سعة ${t.capacity})</option>`)
    .join('');
  openModal('modal-move-table');
}

/**
 * Moves the active order from the current table to another (empty) table.
 */
async function moveTableOrder() {
  const sourceId = state.selectedTableId;
  const targetId = document.getElementById('move-table-select').value;
  if (!sourceId || !targetId || sourceId === targetId) return;

  const sourceTable = state.tables.find(t => t.id === sourceId);
  const targetTable = state.tables.find(t => t.id === targetId);
  if (!sourceTable || !targetTable) return;

  // 1. Persist current cart into the order before moving
  let order = (state.activeOrders || {})[sourceId];
  if (!order) {
    order = {
      tableId: sourceId,
      items: [],
      customerName: state.currentCart.customerName || 'زبون عام',
      customerCount: state.currentCart.customerCount || 1,
      startTime: state.currentCart.startTime || Date.now()
    };
  }
  order.items = [...state.currentCart.items];

  // 2. Optimistic state update - memory first for instant UI
  order.tableId = targetId;
  if (!state.activeOrders) state.activeOrders = {};
  state.activeOrders[targetId] = order;
  delete state.activeOrders[sourceId];
  delete state.lastSavedItems[sourceId];

  sourceTable.status = 'available';
  targetTable.status = 'occupied';

  // 3. Switch to the target table and keep the order open there
  state.selectedTableId = targetId;
  state.currentCart.items = [...order.items];
  state.currentCart.customerName = order.customerName || '';
  state.currentCart.customerCount = order.customerCount || 1;
  state.currentCart.startTime = order.startTime || Date.now();
  state.lastSavedItems[targetId] = JSON.parse(JSON.stringify(order.items));

  closeModal('modal-move-table');
  openOrderSlideOver(targetId);
  renderDashboard();

  // 4. Fire DB writes in background - non-blocking
  state.db.saveActiveOrder(targetId, order).catch(err =>
    console.error('Move: save target order failed:', err)
  );
  state.db.clearActiveOrder(sourceId).catch(err =>
    console.error('Move: clear source order failed:', err)
  );
  state.db.updateTableStatus(targetId, 'occupied').catch(err =>
    console.error('Move: update target status failed:', err)
  );
  state.db.updateTableStatus(sourceId, 'available').catch(err =>
    console.error('Move: update source status failed:', err)
  );
}

/**
 * Cancels the whole active order of the current table and frees it.
 */
async function cancelTableOrder() {
  if (!state.selectedTableId) return;
  const table = state.tables.find(t => t.id === state.selectedTableId);
  if (!table) return;

  if (!confirm(`هل أنت متأكد من إلغاء طلب طاولة ${table.number} بالكامل؟\nسيتم حذف جميع الطلبات المسجلة على هذه الطاولة ولا يمكن التراجع.`)) return;

  const activeOrder = (state.activeOrders || {})[state.selectedTableId];
  if (activeOrder && activeOrder.items) {
    // Cancel against the last saved/printed snapshot so ALL printed items get
    // cancellation tickets, even if the cart was edited before canceling.
    const savedItems = state.lastSavedItems[state.selectedTableId] !== undefined
      ? state.lastSavedItems[state.selectedTableId]
      : activeOrder.items;
    const savedSnapshot = JSON.parse(JSON.stringify(savedItems));
    await detectAndPrintCanceledItems(state.selectedTableId, savedSnapshot, []);
  }

  // 1. Optimistic state update - memory first
  table.status = 'available';
  if (state.activeOrders) delete state.activeOrders[state.selectedTableId];
  state.currentCart.items = [];
  state.currentCart.customerName = '';
  state.currentCart.customerCount = 1;
  delete state.lastSavedItems[state.selectedTableId];

  closeOrderSlideOver();
  renderDashboard();

  // 2. Fire DB writes in background - non-blocking
  state.db.clearActiveOrder(state.selectedTableId).catch(err =>
    console.error('Cancel: clear order failed:', err)
  );
  state.db.updateTableStatus(state.selectedTableId, 'available').catch(err =>
    console.error('Cancel: update status failed:', err)
  );
}

// ==========================================================================
// 3. Checkout Confirmation & Bill Finalization
// ==========================================================================

function openCheckoutConfirmModal() {
  if (!state.selectedTableId) return;
  const table = state.tables.find(t => t.id === state.selectedTableId);
  if (!table) return;

  // Reset checkout processing lock & button state
  state.isProcessingCheckout = false;
  const confirmBtn = document.getElementById('btn-confirm-checkout');
  if (confirmBtn) {
    confirmBtn.disabled = false;
    confirmBtn.innerHTML = 'إتمام الدفع وطباعة الفاتورة';
  }

  // Update header and time
  document.getElementById('chk-table-label').textContent = `فاتورة طاولة ${table.number}`;
  document.getElementById('chk-time-label').textContent = `وقت الدخول: ${new Date(state.currentCart.startTime).toLocaleTimeString('ar-SY')}`;

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

  const grandTotal = subtotal;

  document.getElementById('chk-subtotal').textContent = formatCurrency(subtotal);

  // Hide discount row initially
  const discountRow = document.getElementById('chk-discount-row');
  if (discountRow) {
    discountRow.style.display = 'none';
    document.getElementById('chk-discount').textContent = `-0 ل.س`;
  }

  document.getElementById('chk-total').textContent = formatCurrency(grandTotal);

  // Initialize currency UI
  const curRadio = document.querySelector('input[name="currency-type"]:checked');
  if (curRadio) curRadio.checked = false;
  document.querySelector('input[name="currency-type"][value="syrian"]').checked = true;
  document.getElementById('exchange-rate-input').value = '';
  if (typeof toggleCurrencyRateInput === 'function') toggleCurrencyRateInput();

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
  const grandTotal = netSubtotal;

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
  document.getElementById('chk-total').textContent = formatCurrency(grandTotal);
  updateDollarTotalPreview();
}

/**
 * Toggles exchange rate input visibility based on currency selection.
 */
function toggleCurrencyRateInput() {
  const currencyType = document.querySelector('input[name="currency-type"]:checked')?.value || 'syrian';
  const container = document.getElementById('exchange-rate-container');
  if (container) {
    if (currencyType === 'dollar') {
      container.style.display = 'block';
      updateDollarTotalPreview();
    } else {
      container.style.display = 'none';
      const exchangeInput = document.getElementById('exchange-rate-input');
      if (exchangeInput) exchangeInput.value = '';
      updateDollarTotalPreview();
    }
  }
}

/**
 * Dynamically computes and previews the total in USD based on the exchange rate.
 */
function updateDollarTotalPreview() {
  const currencyType = document.querySelector('input[name="currency-type"]:checked')?.value || 'syrian';
  const exchangeRateInput = document.getElementById('exchange-rate-input');
  const exchangeRate = parseFloat(exchangeRateInput?.value) || 0;
  const dollarPreview = document.getElementById('dollar-total-preview');
  if (!dollarPreview) return;

  if (currencyType === 'dollar' && exchangeRate > 0) {
    const discountInput = document.getElementById('checkout-discount-input');
    const discount = discountInput ? (parseFloat(discountInput.value) || 0) : 0;
    let subtotal = 0;
    state.currentCart.items.forEach(item => {
      const originalTotal = item.price * item.quantity;
      const totalItem = item.isHospitality ? 0 : originalTotal;
      subtotal += totalItem;
    });
    const netSubtotal = Math.max(0, subtotal - discount);
    const total = netSubtotal;
    const dollarTotal = parseFloat((total / exchangeRate).toFixed(2));
    dollarPreview.textContent = `المبلغ المستحق بالدولار: $${dollarTotal}`;
  } else {
    dollarPreview.textContent = 'المبلغ المستحق بالدولار: $0.00';
  }
}

/**
 * Finalizes the checkout, saves sales history record, and releases the table.
 */
async function executeCheckout() {
  // Prevent duplicate execution from double clicks or rapid multi-triggers
  if (state.isProcessingCheckout) return;
  if (!state.selectedTableId) return;

  const tableId = state.selectedTableId;
  const table = state.tables.find(t => t.id === tableId);
  if (!table) return;

  if (!state.currentCart.items || state.currentCart.items.length === 0) {
    alert('لا يمكن ترحيل الفاتورة لأن الطلب فارغ!');
    return;
  }

  // Engage checkout lock and disable button immediately
  state.isProcessingCheckout = true;
  const confirmBtn = document.getElementById('btn-confirm-checkout');
  if (confirmBtn) {
    confirmBtn.disabled = true;
    confirmBtn.innerHTML = '<span style="display:inline-block; margin-left:6px;">⏳</span> جاري ترحيل الفاتورة...';
  }

  try {
    const pMethod = document.querySelector('input[name="payment-method"]:checked')?.value || 'cash';

    const discountInput = document.getElementById('checkout-discount-input');
    const discount = discountInput ? (parseFloat(discountInput.value) || 0) : 0;

    let subtotal = 0;
    state.currentCart.items.forEach(item => {
      const originalTotal = item.price * item.quantity;
      const totalItem = item.isHospitality ? 0 : originalTotal;
      subtotal += totalItem;
    });

    const netSubtotal = Math.max(0, subtotal - discount);
    const total = netSubtotal;

    // Print any remaining unprinted kitchen tickets before finalizing the order
    try {
      await printKitchenAuto();
    } catch (printErr) {
      console.warn('Kitchen auto-print during checkout note:', printErr);
    }

    // Pre-generate invoice ID locally so the UI does not wait for any DB round-trip
    const invoiceId = String(Date.now());

    // Check currency
    const currencyType = document.querySelector('input[name="currency-type"]:checked')?.value || 'syrian';
    const exchangeRateInput = document.getElementById('exchange-rate-input');
    const exchangeRate = parseFloat(exchangeRateInput?.value) || null;
    let dollarTotal = null;

    if (currencyType === 'dollar' && exchangeRate > 0) {
      dollarTotal = parseFloat((total / exchangeRate).toFixed(2));
    }

    const saleRecord = {
      id: invoiceId,
      timestamp: Date.now(),
      tableNumber: table.number,
      customerName: state.currentCart.customerName || 'زبون عام',
      guestCount: state.currentCart.customerCount || 1,
      items: JSON.parse(JSON.stringify(state.currentCart.items)).map(it => {
        const { printedQty, ...rest } = it;
        return rest;
      }),
      subtotal: subtotal,
      discount: discount,
      total: total,
      currencyType: currencyType,
      exchangeRate: exchangeRate,
      dollarTotal: dollarTotal,
      paymentMethod: pMethod,
      startTime: state.currentCart.startTime || Date.now(),
      endTime: Date.now()
    };

    // 1. Optimistic state update - update memory FIRST so every dependent render is instant
    table.status = 'available';
    if (state.activeOrders) delete state.activeOrders[tableId];
    delete state.lastSavedItems[tableId];
    state.currentCart.items = [];
    state.currentCart.customerName = '';
    state.currentCart.customerCount = 1;
    if (!state.salesHistory) state.salesHistory = [];
    state.salesHistory.push(saleRecord);
    updateGlobalStatsUI();

    // 2. Close modals and slideover IMMEDIATELY (renderDashboard is now synchronous)
    closeModal('modal-checkout');
    closeOrderSlideOver();

    // 3. Auto-print receipt immediately (routes to configured main printers, else default)
    printReceiptToMainPrinters(saleRecord, invoiceId);

    // 4. Switch to reports and show receipt preview
    switchTab('reports');
    showReceiptPreview(invoiceId);

    // 5. Fire all DB writes in background - completely non-blocking
    state.db.addSale({ ...saleRecord }).catch(err => console.error('Sale save failed:', err));
    state.db.clearActiveOrder(tableId).catch(err => console.error('Clear active order failed:', err));
    state.db.updateTableStatus(tableId, 'available').catch(err => console.error('Update table status failed:', err));
  } catch (err) {
    console.error('Execute checkout failed:', err);
    alert('حدث خطأ أثناء ترحيل الفاتورة. يرجى المحاولة مرة أخرى.');
  } finally {
    state.isProcessingCheckout = false;
    if (confirmBtn) {
      confirmBtn.disabled = false;
      confirmBtn.innerHTML = 'إتمام الدفع وطباعة الفاتورة';
    }
  }
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
  await refreshStateData({ menu: true });
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
  await refreshStateData({ menu: true });
  renderMenuManager();
}

async function deleteCategory(id) {
  if (confirm('هل أنت متأكد من حذف هذا التصنيف؟ سيتم حذف جميع الأطعمة المرتبطة به تلقائياً!')) {
    await state.db.deleteCategory(id);
    if (state.selectedCategoryFilter === id) {
      state.selectedCategoryFilter = 'all';
    }
    await refreshStateData({ menu: true });
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
  await refreshStateData({ menu: true });
  renderMenuManager();
}

async function deleteProduct(id) {
  if (confirm('هل أنت متأكد من حذف هذا المنتج نهائياً من المنيو؟')) {
    await state.db.deleteProduct(id);
    await refreshStateData({ menu: true });
    renderMenuManager();
  }
}

// ==========================================================================
// 5. Tables Layout Settings (CRUD)
// ==========================================================================

let draggedTableId = null;

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
    tr.setAttribute('draggable', 'true');
    tr.setAttribute('data-id', tbl.id);
    tr.style.cursor = 'grab';

    tr.addEventListener('dragstart', (e) => {
      draggedTableId = tbl.id;
      e.dataTransfer.effectAllowed = 'move';
      tr.style.opacity = '0.5';
    });

    tr.addEventListener('dragover', (e) => {
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
      tr.style.borderTop = '2px solid #10b981';
    });

    tr.addEventListener('dragleave', (e) => {
      tr.style.borderTop = '';
    });

    tr.addEventListener('drop', async (e) => {
      e.preventDefault();
      tr.style.borderTop = '';
      tr.style.opacity = '1';
      const targetId = tbl.id;
      if (draggedTableId && draggedTableId !== targetId) {
        await handleTableReorder(draggedTableId, targetId);
      }
    });

    tr.addEventListener('dragend', () => {
      tr.style.opacity = '1';
      tr.style.borderTop = '';
      draggedTableId = null;
    });

    let statusClass = 'available';
    let statusTxt = 'فارغة';
    if (tbl.status === 'occupied') { statusClass = 'occupied'; statusTxt = 'مشغولة'; }
    if (tbl.status === 'billing') { statusClass = 'billing'; statusTxt = 'طلب الفاتورة'; }

    tr.innerHTML = `
      <td><strong>☰ طاولة ${tbl.number}</strong></td>
      <td>${tbl.capacity} أفراد</td>
      <td><span class="badge-status ${statusClass}">${statusTxt}</span></td>
      <td style="display: flex; gap: 4px; flex-wrap: wrap;">
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

async function handleTableReorder(sourceId, targetId) {
  // Initialize sortOrders if missing
  state.tables.forEach((t, i) => {
    if (t.sortOrder === undefined) t.sortOrder = i;
  });

  const sourceIndex = state.tables.findIndex(t => t.id === sourceId);
  const targetIndex = state.tables.findIndex(t => t.id === targetId);

  if (sourceIndex === -1 || targetIndex === -1) return;

  const item = state.tables.splice(sourceIndex, 1)[0];
  state.tables.splice(targetIndex, 0, item);

  // Update sortOrders
  const promises = [];
  state.tables.forEach((t, i) => {
    t.sortOrder = i;
    promises.push(state.db.put('tables', t));
  });

  try {
    await Promise.all(promises);
    await refreshStateData({ tables: true });
    renderTablesSettings();
  } catch (err) {
    console.error('Failed to reorder tables:', err);
  }
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
  await refreshStateData({ tables: true });

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
    await refreshStateData({ tables: true });
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
    // Persist to DB and wait for confirmation. If DB isn't initialized this will throw.
    await state.db.put('settings', { id: 'tax_rate', value: taxRateVal });

    // Update state and reload settings from DB to ensure consistency
    state.taxRate = taxRateVal;
    await refreshStateData({ settings: true });

    alert('تم حفظ إعدادات النظام وتحديث نسبة الضريبة بنجاح.');

    if (state.activeTab === 'dashboard') renderDashboard();
  } catch (error) {
    console.error('Failed to save system settings:', error);
    alert('حدث خطأ أثناء حفظ الإعدادات. تأكد من اتصال قاعدة البيانات: ' + (error && error.message ? error.message : error));
  }
}

/**
 * Manually refresh settings from server and update UI.
 */
async function refreshSettingsNow() {
  if (!state.db) {
    alert('قاعدة البيانات غير متصلة، لا يمكن تحديث الإعدادات الآن.');
    return;
  }

  try {
    console.log('Manual settings refresh requested.');
    await refreshStateData({ settings: true });
    alert('تم تحديث الإعدادات من الخادم بنجاح.');
  } catch (err) {
    console.error('Failed to refresh settings:', err);
    alert('فشل تحديث الإعدادات: ' + (err && err.message ? err.message : err));
  }
}

window.refreshSettingsNow = refreshSettingsNow;

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
    sidebarTitle.textContent = `${state.restaurantName || 'Restaurant'} POS`;
  }

  // 3. Update Browser Title
  document.title = `${state.restaurantName || 'Restaurant'} POS | نظام إدارة المطاعم الذكي`;

  // 4. Update settings form values if they exist in DOM
  const inputName = document.getElementById('settings-brand-name');
  if (inputName) inputName.value = (typeof state.restaurantName !== 'undefined') ? state.restaurantName : 'Restaurant';

  const inputSlogan = document.getElementById('settings-brand-slogan');
  if (inputSlogan) inputSlogan.value = (typeof state.restaurantSlogan !== 'undefined') ? state.restaurantSlogan : 'eatery & Social House';

  const inputFooter = document.getElementById('settings-brand-footer');
  if (inputFooter) inputFooter.value = (typeof state.restaurantFooter !== 'undefined') ? state.restaurantFooter : 'Restaurant POS System By Salem Makoukji';

  const logoPreview = document.getElementById('settings-logo-preview');
  if (logoPreview) logoPreview.src = state.restaurantLogo || './assets/logo.png';

  // Also keep tax input in sync when brand/settings update comes from DB
  const taxRateInput = document.getElementById('settings-tax-rate');
  if (taxRateInput && typeof state.taxRate !== 'undefined') {
    taxRateInput.value = state.taxRate;
  }

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
  const nameVal = document.getElementById('settings-brand-name').value.trim() || 'Restaurant';
  const sloganVal = document.getElementById('settings-brand-slogan').value.trim() || '';
  const footerVal = document.getElementById('settings-brand-footer').value.trim() || '';

  try {
    // Persist all brand settings and wait for completion so failures surface to the user
    const ops = [
      state.db.put('settings', { id: 'restaurant_name', value: nameVal }),
      state.db.put('settings', { id: 'restaurant_slogan', value: sloganVal }),
      state.db.put('settings', { id: 'restaurant_footer', value: footerVal })
    ];

    if (uploadedLogoBase64) {
      ops.push(state.db.put('settings', { id: 'restaurant_logo', value: uploadedLogoBase64 }));
    }

    await Promise.all(ops);

    // Update state and refresh from DB to ensure UI reflects persisted values
    state.restaurantName = nameVal;
    state.restaurantSlogan = sloganVal;
    state.restaurantFooter = footerVal;
    if (uploadedLogoBase64) {
      state.restaurantLogo = uploadedLogoBase64;
      uploadedLogoBase64 = null;
    }

    await refreshStateData({ settings: true });
    updateBrandUI();

    alert('تم حفظ تفاصيل الهوية وتحديث الشعار بنجاح.');
  } catch (error) {
    console.error('Failed to save brand settings:', error);
    alert('حدث خطأ أثناء حفظ تفاصيل الهوية. تأكد من اتصال قاعدة البيانات: ' + (error && error.message ? error.message : error));
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
  const productMap = new Map();
  state.products.forEach(p => productMap.set(p.id, p));
  const categoryMap = new Map();
  state.categories.forEach(c => categoryMap.set(c.id, c));

  filteredSales.forEach(sale => {
    sale.items.forEach(item => {
      // Find category of item
      const prod = productMap.get(item.productId);
      if (prod) {
        const cat = categoryMap.get(prod.categoryId);
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

    const formattedDate = new Date(sale.timestamp).toLocaleString('ar-SY', {
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
        <button class="btn btn-secondary btn-xs" onclick="event.stopPropagation(); showReceiptPreview('${sale.id}')">
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

  const sale = state.salesHistory.find(s => String(s.id) === String(saleId));
  const container = document.getElementById('receipt-preview-container');
  if (!sale || !container) return;

  const formattedInvoiceId = 'Bis-' + String(sale.id).padStart(6, '0');
  const formattedDate = new Date(sale.timestamp).toLocaleString('ar-SY');

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

  let dollarHtml = '';
  if (sale.currencyType === 'dollar' && sale.dollarTotal) {
    dollarHtml = `
      <div style="display: flex; justify-content: space-between; margin-bottom: 6px; font-weight: bold; color: #193B23;">
        <span>المدفوع بالدولار ($):</span>
        <span>$${sale.dollarTotal}</span>
      </div>
      <div style="font-size: 11px; text-align: right; color: #555; margin-bottom: 6px;">سعر الصرف: ${sale.exchangeRate} ل.س</div>
    `;
  }

  container.innerHTML = `
    <div style="width: 100%; display:flex; flex-direction:column; align-items:center;">
      <div class="restaurant-receipt" id="printable-receipt-element" style="background: #fff; color: #000; padding: 20px; border-radius: 8px; box-shadow: 0 4px 12px rgba(0,0,0,0.06); width: 100%; max-width: 320px; box-sizing: border-box; font-family: 'Cairo', sans-serif; direction: rtl;">
        <div class="receipt-header" style="text-align: center; margin-bottom: 15px;">
          <h2 style="font-size: 24px; font-weight: 800; margin: 0; color: #000; letter-spacing: 1px;">${state.restaurantName !== undefined && state.restaurantName !== null ? state.restaurantName : 'Restaurant'}</h2>
          <p style="font-size: 12px; font-style: italic; margin: 2px 0 0 0; color: #555;">${state.restaurantSlogan !== undefined && state.restaurantSlogan !== null ? state.restaurantSlogan : 'eatery & Social House'}</p>
        </div>
        
        <div style="border-top: 1px dashed #000; margin: 10px 0;"></div>
        
        <div class="receipt-details-row" style="display: flex; justify-content: space-between; margin-bottom: 10px; font-size: 14.5px; line-height: 1.45;">
          <span style="font-weight: 600;">رقم الفاتورة:</span>
          <span style="font-family: monospace; font-weight: bold;">${formattedInvoiceId}</span>
        </div>
        <div class="receipt-details-row" style="display: flex; justify-content: space-between; margin-bottom: 10px; font-size: 14.5px; line-height: 1.45;">
          <span style="font-weight: 600;">طاولة:</span>
          <span>طاولة ${sale.tableNumber}</span>
        </div>
        <div class="receipt-details-row" style="display: flex; justify-content: space-between; margin-bottom: 10px; font-size: 14.5px; line-height: 1.45;">
          <span style="font-weight: 600;">الزبون:</span>
          <span>${sale.customerName || 'زبون عام'}</span>
        </div>
        <div class="receipt-details-row" style="display: flex; justify-content: space-between; margin-bottom: 10px; font-size: 14.5px; line-height: 1.45;">
          <span style="font-weight: 600;">طريقة الدفع:</span>
          <span>${displayPaymentMethod}</span>
        </div>
        <div class="receipt-details-row" style="display: flex; justify-content: space-between; margin-bottom: 10px; font-size: 14.5px; line-height: 1.45; color: #333;">
          <span style="font-weight: 600;">التاريخ والوقت:</span>
          <span style="font-size: 13.5px;">${formattedDate}</span>
        </div>
        
        <div style="border-top: 1px dashed #000; margin: 12px 0;"></div>
        
        <table style="width: 100%; border-collapse: collapse; margin: 12px 0; font-size: 14.5px; line-height: 1.45;">
          <thead>
            <tr>
              <th style="text-align: right; border-bottom: 1px dashed #000; padding-bottom: 8px; width: 55%; font-weight: 700;">الصنف</th>
              <th style="text-align: center; border-bottom: 1px dashed #000; padding-bottom: 8px; width: 15%; font-weight: 700;">العدد</th>
              <th style="text-align: left; border-bottom: 1px dashed #000; padding-bottom: 8px; width: 30%; font-weight: 700;">الإجمالي</th>
            </tr>
          </thead>
          <tbody>
            ${itemsHtml}
          </tbody>
        </table>
        
        <div style="border-top: 1px dashed #000; margin: 12px 0;"></div>
        
        <div class="receipt-totals" style="font-size: 14.5px; margin-top: 12px; line-height: 1.45;">
          <div style="display: flex; justify-content: space-between; margin-bottom: 8px;">
            <span>المجموع الفرعي:</span>
            <span>${formatCurrency(sale.subtotal)}</span>
          </div>
          ${discountHtml}
          <div class="row grand-total" style="display: flex; justify-content: space-between; font-weight: 800; font-size: 17px; border-top: 1px dashed #000; padding-top: 10px; margin-top: 10px;">
            <span>المجموع النهائي:</span>
            <span>${formatCurrency(sale.total)}</span>
          </div>
          <div style="font-size: 11px; text-align: center; color: #555; margin-top: 4px;">
            (السعر بالليرة القديمة: ${Math.round(sale.total * 100).toLocaleString('en-US')} ل.س)
          </div>
          ${dollarHtml}
        </div>
        
        <div style="border-top: 1px dashed #000; margin: 15px 0 10px 0;"></div>
        
        <div class="receipt-footer" style="text-align: center; margin-top: 10px; font-size: 12px;">
          <p style="font-size: 10px; color: #666; margin: 4px 0 0 0;">${state.restaurantFooter !== undefined && state.restaurantFooter !== null ? state.restaurantFooter : 'Restaurant POS System By Salem Makoukji'}</p>
        </div>
      </div>
      
      <div class="print-receipt-btn-wrapper" style="margin-top: 15px;">
        <button class="btn btn-primary" onclick="printReceiptSlipById('${sale.id}')">
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
  const formattedDate = new Date(sale.timestamp || sale.endTime || Date.now()).toLocaleString('ar-SY');

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

  let dollarHtml = '';
  if (sale.currencyType === 'dollar' && sale.dollarTotal) {
    dollarHtml = `
      <div class="row" style="color: #000; font-weight: bold; margin-top: 2mm;">
        <span>المدفوع بالدولار ($):</span>
        <span>$${sale.dollarTotal}</span>
      </div>
      <div style="font-size: 10px; text-align: right; color: #555;">سعر الصرف: ${sale.exchangeRate} ل.س</div>
    `;
  }

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
            font-size: 13.5px;
            line-height: 1.45;
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
            margin-bottom: 4.5mm;
          }
          .receipt-header h2 {
            margin: 0;
            font-size: 22px;
            font-weight: 800;
            letter-spacing: 1px;
            color: #000;
          }
          .receipt-header p {
            margin: 2px 0 0 0;
            font-size: 12px;
            font-style: italic;
          }
          .receipt-divider {
            border-top: 1px dashed #000;
            margin: 3.5mm 0;
            height: 0;
          }
          .receipt-details-row {
            display: flex;
            justify-content: space-between;
            margin-bottom: 2.5mm;
            font-size: 13.5px;
          }
          .receipt-details-row span:first-child {
            font-weight: 600;
          }
          .receipt-table {
            width: 100%;
            border-collapse: collapse;
            margin: 3.5mm 0;
          }
          .receipt-table th {
            border-bottom: 1px dashed #000;
            padding: 2.5mm 0;
            font-size: 13.5px;
            font-weight: 700;
          }
          .receipt-table td {
            font-size: 13.5px;
            padding: 2mm 0;
          }
          .receipt-totals {
            margin-top: 3.5mm;
            font-size: 13.5px;
          }
          .receipt-totals .row {
            display: flex;
            justify-content: space-between;
            margin-bottom: 2.5mm;
          }
          .receipt-totals .row.grand-total {
            font-weight: 800;
            font-size: 15.5px;
            border-top: 1px dashed #000;
            padding-top: 3.5mm;
            margin-top: 2.5mm;
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
            <h2>${state.restaurantName !== undefined && state.restaurantName !== null ? state.restaurantName : 'Restaurant'}</h2>
            <p>${state.restaurantSlogan !== undefined && state.restaurantSlogan !== null ? state.restaurantSlogan : 'eatery & Social House'}</p>
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
            <div class="row grand-total">
              <span>المجموع النهائي:</span>
              <span>${formatCurrency(sale.total)}</span>
            </div>
            <div style="font-size: 10px; text-align: center; color: #555; margin-top: 2mm;">
              (السعر بالليرة القديمة: ${Math.round(sale.total * 100).toLocaleString('en-US')} ل.س)
            </div>
            ${dollarHtml}
          </div>
          
          <div class="receipt-divider"></div>
          
          <div class="receipt-footer">
            <p style="font-size: 9px; color: #555; margin-top: 4px;">${state.restaurantFooter !== undefined && state.restaurantFooter !== null ? state.restaurantFooter : 'Restaurant POS System By Salem Makoukji'}</p>
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
  const sale = state.salesHistory.find(s => String(s.id) === String(saleId));
  if (sale) {
    printReceiptToMainPrinters(sale, sale.id);
  }
}

async function confirmClearSalesHistory() {
  if (confirm('تنبيه هام! هل أنت متأكد من رغبتك في حذف سجل المبيعات بالكامل؟ لا يمكن التراجع عن هذا الإجراء.')) {
    await state.db.clearSalesHistory();
    await refreshStateData({ sales: true });
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

    const [tables, categories, products, activeOrders, salesHistory, settings, reservations, printers] = await Promise.all([
      state.db.getAll('tables'),
      state.db.getAll('categories'),
      state.db.getAll('products'),
      state.db.getAll('active_orders'),
      state.db.getAll('sales_history'),
      state.db.getAll('settings'),
      state.db.getAll('reservations'),
      state.db.getAll('printers')
    ]);

    const backupData = {
      version: 1.1,
      timestamp: Date.now(),
      tables,
      categories,
      products,
      active_orders: activeOrders,
      sales_history: salesHistory,
      settings,
      reservations,
      printers
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
      await Promise.all([
        state.db.clearStore('tables'),
        state.db.clearStore('categories'),
        state.db.clearStore('products'),
        state.db.clearStore('active_orders'),
        state.db.clearStore('sales_history'),
        state.db.clearStore('settings'),
        state.db.clearStore('reservations'),
        state.db.clearStore('printers')
      ]);

      const putPromises = [];
      // 2. Insert tables
      for (const tbl of backupData.tables) {
        putPromises.push(state.db.put('tables', tbl));
      }

      // 3. Insert categories
      for (const cat of backupData.categories) {
        putPromises.push(state.db.put('categories', cat));
      }

      // 4. Insert products
      for (const prod of backupData.products) {
        putPromises.push(state.db.put('products', prod));
      }

      // 5. Insert active orders (if any exist in backup)
      if (Array.isArray(backupData.active_orders)) {
        for (const ord of backupData.active_orders) {
          putPromises.push(state.db.put('active_orders', ord));
        }
      }

      // 6. Insert sales history (if any exist in backup)
      if (Array.isArray(backupData.sales_history)) {
        for (const sale of backupData.sales_history) {
          putPromises.push(state.db.put('sales_history', sale));
        }
      }

      // 7. Insert settings (if any exist in backup)
      if (Array.isArray(backupData.settings)) {
        for (const set of backupData.settings) {
          putPromises.push(state.db.put('settings', set));
        }
      }

      // 8. Insert reservations (if any exist in backup)
      if (Array.isArray(backupData.reservations)) {
        for (const res of backupData.reservations) {
          putPromises.push(state.db.put('reservations', res));
        }
      }

      // 9. Insert printers (if any exist in backup)
      if (Array.isArray(backupData.printers)) {
        for (const pr of backupData.printers) {
          putPromises.push(state.db.put('printers', pr));
        }
      }

      await Promise.all(putPromises);

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

// ==========================================================================
// 5. Table Reservations Module
// ==========================================================================

function renderReservations() {
  const tableBody = document.getElementById('reservations-list-body');
  if (!tableBody) return;

  const localDate = new Date();
  const year = localDate.getFullYear();
  const month = String(localDate.getMonth() + 1).padStart(2, '0');
  const day = String(localDate.getDate()).padStart(2, '0');
  const todayIso = `${year}-${month}-${day}`;

  // Initialize date filter element value on load
  const dateFilterInput = document.getElementById('res-filter-date');
  if (dateFilterInput && !dateFilterInput.value && state.activeReservationDateFilter === 'today') {
    dateFilterInput.value = todayIso;
  }

  // Calculate Metrics
  const todayReservations = state.reservations.filter(res => res.reservationDate === todayIso);
  const totalCountToday = todayReservations.length;
  const confirmedCountToday = todayReservations.filter(res => res.status === 'confirmed').length;
  const pendingCountToday = todayReservations.filter(res => res.status === 'pending').length;

  document.getElementById('stat-res-today').textContent = `${totalCountToday} حجز`;
  document.getElementById('stat-res-confirmed').textContent = `${confirmedCountToday} حجز`;
  document.getElementById('stat-res-pending').textContent = `${pendingCountToday} حجز`;

  tableBody.innerHTML = '';

  const activeFiltersSearch = document.getElementById('res-search-input') ? document.getElementById('res-search-input').value.trim().toLowerCase() : '';
  const filterDateValue = dateFilterInput ? dateFilterInput.value : '';

  // Filter reservations array based on active selections
  const filtered = state.reservations.filter(res => {
    // 1. Status Filter
    if (state.activeReservationFilter !== 'all' && res.status !== state.activeReservationFilter) return false;

    // 2. Date Filter
    if (state.activeReservationDateFilter === 'today') {
      if (res.reservationDate !== todayIso) return false;
    } else if (state.activeReservationDateFilter === 'custom') {
      if (filterDateValue && res.reservationDate !== filterDateValue) return false;
    }

    // 3. Search filter (Name or Phone)
    if (activeFiltersSearch) {
      const name = String(res.customerName || '').toLowerCase();
      const phone = String(res.phoneNumber || '').toLowerCase();
      if (!name.includes(activeFiltersSearch) && !phone.includes(activeFiltersSearch)) return false;
    }

    return true;
  });

  if (filtered.length === 0) {
    tableBody.innerHTML = `<tr><td colspan="8" style="text-align: center; color: var(--text-muted); padding: 20px;">لا توجد أي حجوزات تطابق خيارات التصفية الحالية.</td></tr>`;
    return;
  }

  filtered.forEach(res => {
    const tr = document.createElement('tr');

    // Status Badge Style
    let statusClass = 'badge-pending';
    let statusText = 'قيد الانتظار';
    if (res.status === 'confirmed') {
      statusClass = 'badge-confirmed';
      statusText = 'مؤكدة';
    } else if (res.status === 'seated') {
      statusClass = 'badge-seated';
      statusText = 'تم الجلوس';
    } else if (res.status === 'cancelled') {
      statusClass = 'badge-cancelled';
      statusText = 'ملغاة';
    }

    // Actions
    let actionButtons = '';
    if (res.status === 'pending') {
      actionButtons += `<button class="btn btn-secondary btn-xs" onclick="updateReservationStatus('${res.id}', 'confirmed')" style="margin-left: 4px; background-color: #27ae60; color: white;">تأكيد</button>`;
      actionButtons += `<button class="btn btn-secondary btn-xs" onclick="updateReservationStatus('${res.id}', 'cancelled')" style="margin-left: 4px; background-color: #c0392b; color: white;">إلغاء</button>`;
    } else if (res.status === 'confirmed') {
      actionButtons += `<button class="btn btn-primary btn-xs" onclick="seatReservation('${res.id}')" style="margin-left: 4px; background-color: #193B23; color: white;">حضور وجلوس</button>`;
      actionButtons += `<button class="btn btn-secondary btn-xs" onclick="updateReservationStatus('${res.id}', 'cancelled')" style="margin-left: 4px; background-color: #c0392b; color: white;">إلغاء</button>`;
    } else if (res.status === 'cancelled') {
      actionButtons += `<button class="btn btn-secondary btn-xs" onclick="updateReservationStatus('${res.id}', 'confirmed')" style="margin-left: 4px; background-color: #27ae60; color: white;">إعادة تأكيد</button>`;
    }

    // Edit and Delete are always available
    actionButtons += `<button class="btn btn-secondary btn-xs" onclick="openEditReservationModal('${res.id}')" style="margin-left: 4px;">تعديل</button>`;
    actionButtons += `<button class="btn btn-danger-outline btn-xs" onclick="deleteReservation('${res.id}')">حذف</button>`;

    // Format table name
    let tableNameStr = 'غير محددة';
    if (res.tableId) {
      const associatedTable = state.tables.find(t => t.id === res.tableId);
      if (associatedTable) {
        tableNameStr = `طاولة ${associatedTable.number}`;
      }
    }

    tr.innerHTML = `
      <td><strong>${res.customerName}</strong></td>
      <td>${res.phoneNumber}</td>
      <td>${res.reservationDate} - ${res.reservationTime}</td>
      <td><span class="table-badge" style="display:inline-block; padding: 2px 8px; font-size:12px;">${tableNameStr}</span></td>
      <td>${res.guestCount} فرد</td>
      <td style="max-width: 200px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;" title="${res.notes || ''}">${res.notes || '-'}</td>
      <td><span class="status-indicator-badge ${statusClass}" style="display:inline-block; padding: 4px 10px; border-radius:12px; font-size:12px; font-weight:600;">${statusText}</span></td>
      <td><div style="display: flex; gap: 4px;">${actionButtons}</div></td>
    `;

    tableBody.appendChild(tr);
  });
}

function filterReservationsByStatus(status) {
  state.activeReservationFilter = status;
  document.querySelectorAll('.filter-bar .filter-group .filter-btn').forEach(btn => {
    if (btn.id.includes('res-filter-status-')) {
      btn.classList.remove('active');
    }
  });
  const activeBtn = document.getElementById(`res-filter-status-${status}`);
  if (activeBtn) activeBtn.classList.add('active');
  renderReservations();
}

function setReservationDateFilter(mode) {
  state.activeReservationDateFilter = mode;
  const dateInput = document.getElementById('res-filter-date');
  if (mode === 'all') {
    if (dateInput) dateInput.value = '';
  } else if (mode === 'today') {
    const localDate = new Date();
    const year = localDate.getFullYear();
    const month = String(localDate.getMonth() + 1).padStart(2, '0');
    const day = String(localDate.getDate()).padStart(2, '0');
    const todayIso = `${year}-${month}-${day}`;
    if (dateInput) dateInput.value = todayIso;
  }
  renderReservations();
}

function filterReservations() {
  const dateInput = document.getElementById('res-filter-date');
  if (dateInput && dateInput.value) {
    state.activeReservationDateFilter = 'custom';
  } else {
    state.activeReservationDateFilter = 'all';
  }
  renderReservations();
}

function openAddReservationModal() {
  document.getElementById('reservation-modal-title').textContent = 'إضافة حجز جديد';
  document.getElementById('reservation-form-id').value = '';
  document.getElementById('reservation-form-name').value = '';
  document.getElementById('reservation-form-phone').value = '';
  document.getElementById('reservation-form-notes').value = '';
  document.getElementById('reservation-form-guests').value = '4';

  const todayStr = new Date().toISOString().slice(0, 10);
  document.getElementById('reservation-form-date').value = todayStr;
  document.getElementById('reservation-form-time').value = '19:00';

  // Populate tables dropdown
  populateReservationTablesDropdown();

  openModal('modal-reservation');
}

function populateReservationTablesDropdown(selectedTableId = '') {
  const dropdown = document.getElementById('reservation-form-table');
  if (!dropdown) return;

  dropdown.innerHTML = '<option value="">تحديد لاحقاً / غير محددة</option>';
  (state.tables || []).forEach(tbl => {
    const option = document.createElement('option');
    option.value = tbl.id;
    option.textContent = `طاولة ${tbl.number} (سعة ${tbl.capacity} أفراد)`;
    if (tbl.id === selectedTableId) {
      option.selected = true;
    }
    dropdown.appendChild(option);
  });
}

async function openEditReservationModal(id) {
  const res = state.reservations.find(r => r.id === id);
  if (!res) return;

  document.getElementById('reservation-modal-title').textContent = 'تعديل بيانات الحجز';
  document.getElementById('reservation-form-id').value = res.id;
  document.getElementById('reservation-form-name').value = res.customerName;
  document.getElementById('reservation-form-phone').value = res.phoneNumber;
  document.getElementById('reservation-form-date').value = res.reservationDate;
  document.getElementById('reservation-form-time').value = res.reservationTime;
  document.getElementById('reservation-form-guests').value = res.guestCount;
  document.getElementById('reservation-form-notes').value = res.notes || '';

  populateReservationTablesDropdown(res.tableId);

  openModal('modal-reservation');
}

async function submitReservationForm() {
  const id = document.getElementById('reservation-form-id').value;
  const name = document.getElementById('reservation-form-name').value.trim();
  const phone = document.getElementById('reservation-form-phone').value.trim();
  const date = document.getElementById('reservation-form-date').value;
  const time = document.getElementById('reservation-form-time').value;
  const guests = parseInt(document.getElementById('reservation-form-guests').value) || 4;
  const tableId = document.getElementById('reservation-form-table').value;
  const notes = document.getElementById('reservation-form-notes').value.trim();

  if (!name || !phone || !date || !time) {
    alert('يرجى ملء الحقول الإلزامية: اسم الزبون، الهاتف، التاريخ والوقت.');
    return;
  }

  const reservationData = {
    id: id || null,
    customerName: name,
    phoneNumber: phone,
    reservationDate: date,
    reservationTime: time,
    guestCount: guests,
    tableId: tableId || null,
    notes: notes || '',
    status: id ? (state.reservations.find(r => r.id === id)?.status || 'pending') : 'pending'
  };

  try {
    await state.db.saveReservation(reservationData);
    closeModal('modal-reservation');
    await refreshStateData({ reservations: true });
    renderReservations();
    alert('تم حفظ الحجز بنجاح.');
  } catch (err) {
    console.error('Failed to save reservation:', err);
    alert('حدث خطأ أثناء حفظ الحجز: ' + err.message);
  }
}

async function updateReservationStatus(id, newStatus) {
  const res = state.reservations.find(r => r.id === id);
  if (!res) return;

  res.status = newStatus;

  try {
    await state.db.saveReservation(res);
    await refreshStateData({ reservations: true });
    renderReservations();
  } catch (err) {
    console.error('Failed to update reservation status:', err);
    alert('حدث خطأ أثناء تحديث حالة الحجز: ' + err.message);
  }
}

async function deleteReservation(id) {
  if (!confirm('هل أنت متأكد من رغبتك في حذف هذا الحجز نهائياً من النظام؟')) return;

  try {
    await state.db.deleteReservation(id);
    await refreshStateData({ reservations: true });
    renderReservations();
    alert('تم حذف الحجز بنجاح.');
  } catch (err) {
    console.error('Failed to delete reservation:', err);
    alert('حدث خطأ أثناء حذف الحجز: ' + err.message);
  }
}

async function seatReservation(id) {
  const res = state.reservations.find(r => r.id === id);
  if (!res) return;

  if (!res.tableId) {
    alert('هذا الحجز لا يحتوي على طاولة محددة. يرجى تعديل الحجز واختيار طاولة للزبون أولاً قبل تسكينه.');
    return;
  }

  const associatedTable = state.tables.find(t => t.id === res.tableId);
  if (!associatedTable) {
    alert('الطاولة المرتبطة بهذا الحجز لم تعد متوفرة في النظام.');
    return;
  }

  if (associatedTable.status !== 'available') {
    if (!confirm(`تحذير: الطاولة رقم ${associatedTable.number} مشغولة حالياً في الصالة. هل تريد بالرغم من ذلك تسكين الزبون عليها واستبدال الطلب النشط الحالي؟`)) {
      return;
    }
  }

  try {
    // 1. Update reservation status to seated
    res.status = 'seated';
    await state.db.saveReservation(res);

    // 2. Set Table Status to occupied in Firestore
    await state.db.updateTableStatus(res.tableId, 'occupied');

    // 3. Create a new active order on the table
    const orderData = {
      tableId: res.tableId,
      customerName: res.customerName,
      customerCount: res.guestCount,
      startTime: Date.now(),
      items: [],
      lastUpdated: Date.now()
    };
    await state.db.saveActiveOrder(res.tableId, orderData);

    // 4. Reload data
    await refreshStateData({ tables: true, reservations: true });

    // 5. Instantly transition to dashboard tab and open order slideover
    switchTab('dashboard');
    setTimeout(() => {
      openOrderSlideOver(res.tableId);
    }, 150);

  } catch (err) {
    console.error('Failed to seat reservation:', err);
    alert('حدث خطأ أثناء تسكين الحجز: ' + err.message);
  }
}

// Expose reservations functions globally
window.renderReservations = renderReservations;
window.filterReservationsByStatus = filterReservationsByStatus;
window.setReservationDateFilter = setReservationDateFilter;
window.filterReservations = filterReservations;
window.openAddReservationModal = openAddReservationModal;
window.openEditReservationModal = openEditReservationModal;
window.submitReservationForm = submitReservationForm;
window.updateReservationStatus = updateReservationStatus;
window.deleteReservation = deleteReservation;
window.seatReservation = seatReservation;

// ==========================================================================
// 9. Multi-Printer Management (Kitchen & Main Printers)
// ==========================================================================

function escapeHtml(str) {
  return String(str == null ? '' : str)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

class PrintManager {
  constructor() {
    this.usbSupported = typeof navigator !== 'undefined' && 'usb' in navigator;
  }

  /**
   * Opens the browser chooser to pair a USB thermal (ESC/POS) printer.
   */
  async requestUsbDevice() {
    if (!this.usbSupported) {
      throw new Error('المتصفح الحالي لا يدعم الربط المباشر USB. استخدم Chrome أو Edge على اتصال آمن (HTTPS).');
    }
    const device = await navigator.usb.requestDevice({ filters: [{ classCode: 7 }] });
    return device;
  }

  async _findUsbDevice(printer) {
    if (!this.usbSupported) return null;
    const cfg = printer.usbDevice || {};
    try {
      const devices = await navigator.usb.getDevices();
      if (cfg.serialNumber) {
        const bySerial = devices.find(d => d.serialNumber === cfg.serialNumber);
        if (bySerial) return bySerial;
      }
      return devices.find(d => d.vendorId === cfg.vendorId && d.productId === cfg.productId) || null;
    } catch (err) {
      console.error('Find USB device failed:', err);
      return null;
    }
  }

  async _sendBytesToDevice(device, bytes) {
    let claimedIface = null;
    try {
      await device.open();
      if (!device.configuration) await device.selectConfiguration(1);
      const iface = device.configuration.interfaces.find(i =>
        (i.alternate && (i.alternate.interfaceClass === 7 || i.alternate.interfaceClass === 0))
      ) || device.configuration.interfaces[0];
      if (!iface) throw new Error('تعذر العثور على واجهة الطباعة في الجهاز.');

      try {
        await device.claimInterface(iface.interfaceNumber);
        claimedIface = iface;
      } catch (err) {
        throw new Error(
          'تعذر حجز واجهة الطابعة USB (الجهاز مستخدم من قبل جهة أخرى).\n\n' +
          'الأسباب والحلول:\n' +
          '1. تأكد من إغلاق أي نسخة أخرى من النظام أو أي تطبيق طابعة يستخدم الجهاز.\n' +
          '2. تعريف طابعة وندوز قد يحجز الجهاز: أزل الطابعة من إعدادات Windows ثم أعد المحاولة.\n' +
          '3. اسحب الطابعة وأعد وصلها (USB).\n\n' +
          'الطريقة الأضمن لطباعة تلقائية بدون مشاكل: استخدم "شبكة IP" مع سيرفر الطباعة.'
        );
      }

      const outEndpoint = iface.alternate.endpoints.find(e => e.direction === 'out');
      if (!outEndpoint) throw new Error('تعذر العثور على منفذ الإخراج في الطابعة.');
      await device.transferOut(outEndpoint.endpointNumber, bytes);
    } finally {
      if (claimedIface) {
        try { await device.releaseInterface(claimedIface.interfaceNumber); } catch (e) { /* ignore */ }
      }
      try { await device.close(); } catch (e) { /* ignore */ }
    }
  }

  /**
   * Renders a text chunk on a tight canvas, crops it to its ink bounding box,
   * and returns a 1-bit (dark=1) dotmap {w,h,dark}. The canvas direction is
   * chosen per chunk so Arabic text is shaped and laid out RTL correctly while
   * pure Latin/numeric chunks keep LTR order.
   */
  _renderChunk(text, bold, doubleSize) {
    const px = (doubleSize ? 2 : 1) * 24;
    const R = 2; // supersampling factor
    const fontFamily = 'Cairo, "Segoe UI", Tahoma, Arial, sans-serif';
    const fontStr = (bold ? 'bold ' : '') + px + 'px ' + fontFamily;
    const probe = document.createElement('canvas').getContext('2d');
    probe.font = fontStr;
    const textWpx = probe.measureText(text).width;
    const cw = Math.ceil(textWpx * R) + R * 2;
    const ch = Math.ceil(px * 1.4 * R);
    const c = document.createElement('canvas');
    c.width = cw;
    c.height = ch;
    const g = c.getContext('2d');
    g.direction = /[\u0600-\u06FF\u0750-\u077F]/.test(text) ? 'rtl' : 'ltr';
    g.textAlign = 'left';
    g.textBaseline = 'middle';
    g.fillStyle = '#fff';
    g.fillRect(0, 0, cw, ch);
    g.fillStyle = '#000';
    g.font = (bold ? 'bold ' : '') + (px * R) + 'px ' + fontFamily;
    g.fillText(text, R, ch / 2);

    const data = g.getImageData(0, 0, cw, ch).data;
    let xmin = cw, xmax = -1, ymin = ch, ymax = -1;
    for (let y = 0; y < ch; y++) {
      for (let x = 0; x < cw; x++) {
        const i = (y * cw + x) * 4;
        if (data[i] + data[i + 1] + data[i + 2] < 3 * 200) {
          if (x < xmin) xmin = x;
          if (x > xmax) xmax = x;
          if (y < ymin) ymin = y;
          if (y > ymax) ymax = y;
        }
      }
    }
    if (xmax < xmin || ymax < ymin) return { w: 0, h: 0, dark: null };
    const w = Math.ceil((xmax - xmin + 1) / R);
    const h = Math.ceil((ymax - ymin + 1) / R);
    const dark = new Uint8Array(w * h);
    for (let dy = 0; dy < h; dy++) {
      for (let dx = 0; dx < w; dx++) {
        let s = 0;
        for (let sy = 0; sy < R; sy++) {
          for (let sx = 0; sx < R; sx++) {
            const i = ((Math.min(ymax, ymin + dy * R + sy)) * cw + Math.min(xmax, xmin + dx * R + sx)) * 4;
            s += data[i] + data[i + 1] + data[i + 2];
          }
        }
        dark[dy * w + dx] = s / (R * R * 765) < 0.5 ? 1 : 0;
      }
    }
    return { w, h, dark };
  }

  /**
   * Emits a full-width ESC/POS raster (GS v 0) block. renderRow(row, col)
   * returns true when the dot at (col, row) must be printed.
   */
  _rasterBlock(widthBytes, rows, renderRow) {
    const out = [0x1d, 0x76, 0x30, 0x30, widthBytes & 0xff, (widthBytes >> 8) & 0xff, rows & 0xff, (rows >> 8) & 0xff];
    for (let r = 0; r < rows; r++) {
      for (let b = 0; b < widthBytes; b++) {
        let byte = 0;
        for (let kk = 0; kk < 8; kk++) {
          const col = b * 8 + kk;
          if (col < widthBytes * 8 && renderRow(r, col)) byte |= (1 << (7 - kk));
        }
        out.push(byte);
      }
    }
    return out;
  }

  /**
   * Renders a text line as one or more ESC/POS raster (GS v 0) bitmaps, so
   * Arabic prints correctly on thermal printers whose font ROM cannot display
   * UTF-8 text. Long lines wrap to multiple chunks; each chunk is cropped to
   * its ink box and composed at the requested alignment (center or right,
   * RTL-style). Returns an array of byte arrays.
   */
  _rasterizeText(text, center, bold, doubleSize) {
    const DPI = 203;
    const CSS = 96;
    const dotsW = 576; // 80mm @ 203dpi
    const W = Math.ceil(dotsW / 8) * 8;
    const widthBytes = W / 8;
    const k = DPI / CSS;
    const lineGap = 12; // blank dots between lines
    const rightMargin = 16;
    const px = (doubleSize ? 2 : 1) * 28;
    const fontFamily = 'Cairo, "Segoe UI", Tahoma, Arial, sans-serif';
    const probe = document.createElement('canvas').getContext('2d');
    probe.font = (bold ? 'bold ' : '') + px + 'px ' + fontFamily;
    const maxWpx = dotsW / k;

    const words = String(text).split(/(\s+)/);
    const chunks = [];
    let cur = '';
    for (const w of words) {
      const test = cur + w;
      if (probe.measureText(test).width <= maxWpx || !cur) {
        cur = test;
      } else {
        chunks.push(cur.trim());
        cur = w.trimStart();
        while (probe.measureText(cur).width > maxWpx && cur.length > 1) {
          let lo = 1, hi = cur.length;
          while (lo < hi) {
            const mid = Math.ceil((lo + hi) / 2);
            if (probe.measureText(cur.slice(0, mid)).width <= maxWpx) lo = mid;
            else hi = mid - 1;
          }
          chunks.push(cur.slice(0, lo));
          cur = cur.slice(lo);
        }
      }
    }
    if (cur.trim()) chunks.push(cur.trim());
    if (!chunks.length) chunks.push('');

    const blocks = [];
    for (const chunk of chunks) {
      const c = this._renderChunk(chunk, bold, doubleSize);
      if (!c.dark) continue;
      const xoff = center ? Math.floor((W - c.w) / 2) : W - rightMargin - c.w;
      const rows = c.h + lineGap;
      blocks.push(this._rasterBlock(widthBytes, rows, (r, col) => {
        if (r >= c.h) return false;
        const cx = col - xoff;
        return cx >= 0 && cx < c.w && c.dark[r * c.w + cx] === 1;
      }));
    }
    return blocks;
  }

  /**
   * Renders a two-cell row (right cell = main text, left cell = secondary
   * text, e.g. item name + qty/price) as one or more raster blocks, so
   * receipts mirror the on-screen two-column preview. Each cell wraps
   * independently; paired chunks stay on the same row.
   */
  _rasterizeRow(leftText, rightText, bold, doubleSize) {
    const DPI = 203;
    const CSS = 96;
    const dotsW = 576;
    const W = Math.ceil(dotsW / 8) * 8;
    const widthBytes = W / 8;
    const k = DPI / CSS;
    const lineGap = 10;
    const leftMargin = 8;
    const rightMargin = 16;
    const px = (doubleSize ? 2 : 1) * 26;
    const fontFamily = 'Cairo, "Segoe UI", Tahoma, Arial, sans-serif';
    const probe = document.createElement('canvas').getContext('2d');
    probe.font = (bold ? 'bold ' : '') + px + 'px ' + fontFamily;
    const maxWpx = dotsW / k;

    const wrapCell = (text) => {
      const words = String(text).split(/(\s+)/);
      const chunks = [];
      let cur = '';
      for (const w of words) {
        const test = cur + w;
        if (probe.measureText(test).width <= maxWpx || !cur) {
          cur = test;
        } else {
          chunks.push(cur.trim());
          cur = w.trimStart();
        }
      }
      if (cur.trim()) chunks.push(cur.trim());
      return chunks.length ? chunks : [''];
    };

    const L = wrapCell(leftText);
    const Rt = wrapCell(rightText);
    const n = Math.max(L.length, Rt.length);
    const blocks = [];
    for (let i = 0; i < n; i++) {
      const lc = L[i] ? this._renderChunk(L[i], bold, doubleSize) : null;
      const rc = Rt[i] ? this._renderChunk(Rt[i], bold, doubleSize) : null;
      if (!lc && !rc) continue;
      const lx = lc && lc.dark ? leftMargin : -1;
      const rx = rc && rc.dark ? W - rightMargin - rc.w : -1;
      const inkH = Math.max(lc ? lc.h : 0, rc ? rc.h : 0);
      const rows = inkH + lineGap;
      blocks.push(this._rasterBlock(widthBytes, rows, (r, col) => {
        if (r >= inkH) return false;
        if (lx >= 0) {
          const cx = col - lx;
          if (cx >= 0 && cx < lc.w && lc.dark[r * lc.w + cx] === 1) return true;
        }
        if (rx >= 0) {
          const cx = col - rx;
          if (cx >= 0 && cx < rc.w && rc.dark[r * rc.w + cx] === 1) return true;
        }
        return false;
      }));
    }
    return blocks;
  }

  /**
   * Builds ESC/POS bytes from a set of lines.
   * Each line: { t: text, b: bold, c: center, s: double-size, l?: left cell }
   * Text is rendered as raster bitmaps (see _rasterizeText/_rasterizeRow) so
   * Arabic prints correctly on thermal printers without an Arabic font ROM.
   */
  _buildEscPos(lines, copies) {
    const out = [0x1b, 0x40]; // Initialize printer

    for (let c = 0; c < (copies || 1); c++) {
      for (const line of lines) {
        if (line.empty) {
          out.push(0x0a);
          continue;
        }
        const blocks = line.l != null
          ? this._rasterizeRow(String(line.l), String(line.t), !!line.b, !!line.s)
          : this._rasterizeText(String(line.t), !!line.c, !!line.b, !!line.s);
        for (const blk of blocks) {
          for (const byte of blk) out.push(byte);
        }
      }
      if (c < (copies || 1) - 1) {
        for (let f = 0; f < 3; f++) out.push(0x0a); // Feed between copies
      }
    }
    out.push(0x1d, 0x56, 0x00); // Full cut
    return new Uint8Array(out);
  }

  /**
   * Prints raw text lines to a USB printer.
   */
  async printUsb(printer, lines, copies) {
    const device = await this._findUsbDevice(printer);
    if (!device) {
      throw new Error(`لم يتم العثور على طابعة USB "${printer.name}". أعد ربطها من الإعدادات.`);
    }
    await this._sendBytesToDevice(device, this._buildEscPos(lines, copies));
  }

  /**
   * Converts a Uint8Array to a Base64 string (chunked to avoid stack overflow).
   */
  _bufToBase64(bytes) {
    let bin = '';
    const chunk = 0x8000;
    for (let i = 0; i < bytes.length; i += chunk) {
      bin += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
    }
    return btoa(bin);
  }

  /**
   * Sends raw ESC/POS bytes to a network printer through the local print bridge.
   */
  async _sendToBridge(printer, bytes) {
    const bridge = String(state.printBridgeUrl || 'http://localhost:6333').trim().replace(/\/+$/, '');
    if (!bridge) throw new Error('سيرفر الطباعة الوسيط غير مضبوط. حدد عنوانه من إعدادات النظام.');

    const res = await fetch(bridge + '/print', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        ip: printer.ip || '',
        port: Number(printer.port) || 9100,
        bytesBase64: this._bufToBase64(bytes)
      })
    }).catch(() => {
      throw new Error(`تعذر الاتصال بسيرفر الطباعة الوسيط (${bridge}).\nشغّله على جهاز الكاشير بالأمر: node print-server.js`);
    });

    const data = await res.json().catch(() => ({}));
    if (!res.ok || !data.ok) {
      throw new Error((data.error || '') + (data.device ? ` (${data.device})` : '') || ('سيرفر الطباعة رفض الطلب (HTTP ' + res.status + ')'));
    }
  }

  /**
   * Sends raw ESC/POS bytes to a printer regardless of its connection type
   * (network via bridge or Electron IPC, USB via WebUSB).
   */
  async sendRaw(printer, bytes) {
    if (printer.connection === 'network') {
      if (isElectron) {
        await window.bistroPrint.printRaw({
          ip: printer.ip,
          port: Number(printer.port) || 9100,
          bytesBase64: this._bufToBase64(bytes)
        });
      } else {
        await this._sendToBridge(printer, bytes);
      }
    } else if (printer.connection === 'usb') {
      if (isElectron) {
        await window.bistroPrint.printUsbDirect({
          deviceName: printer.windowsDeviceName || printer.name,
          bytesBase64: this._bufToBase64(bytes)
        });
      } else {
        const device = await this._findUsbDevice(printer);
        if (!device) {
          throw new Error(`لم يتم العثور على طابعة USB "${printer.name}". أعد ربطها من الإعدادات.`);
        }
        await this._sendBytesToDevice(device, bytes);
      }
    }
  }

  /**
   * Routes a set of text lines to the target printer: raw ESC/POS for network
   * and USB printers, silent Windows printing (desktop build), or the system
   * print dialog as a fallback.
   */
  async _routeLines(printer, lines, dialogTitle, dialogHtml) {
    if (printer.connection === 'network' || (printer.connection === 'usb' && this.usbSupported)) {
      await this.sendRaw(printer, this._buildEscPos(lines, printer.copies || 1));
    } else if (printer.connection === 'windows' && isElectron) {
      await window.bistroPrint.printSilent({
        deviceName: printer.windowsDeviceName,
        html: this._buildDialogDoc(dialogTitle, dialogHtml),
        copies: printer.copies || 1
      });
    } else {
      this.printDialog(dialogTitle, dialogHtml);
    }
  }

  /**
   * Builds the full print document (HTML + receipt CSS).
   */
  _buildDialogDoc(title, bodyHtml) {
    return `<!DOCTYPE html><html dir="rtl"><head><meta charset="UTF-8"><title>${title}</title>
      <style>
        @import url('https://fonts.googleapis.com/css2?family=Cairo:wght@400;600;700;800&display=swap');
        * { box-sizing: border-box; }
        @page { size: 72mm auto; margin: 0; }
        body { font-family: 'Cairo', sans-serif; width: 72mm; margin: 0 auto; padding: 2mm 2mm 3mm; direction: rtl; font-size: 11.5px; line-height: 1.45; color: #000; background: #fff; -webkit-print-color-adjust: exact; print-color-adjust: exact; }
        .ticket-header { text-align: center; margin-bottom: 2.5mm; }
        .ticket-header h2 { margin: 0; font-size: 15px; font-weight: 800; }
        .ticket-header p { margin: 1.5px 0; }
        .divider { border-top: 1px dashed #000; margin: 2.5mm 0; }
        .row { display: flex; justify-content: space-between; margin-bottom: 1.8mm; }
        .items-table { width: 100%; }
        .items-table .row { font-size: 12px; font-weight: 700; }
        .qty { text-align: center; font-weight: 800; }
        .footer { text-align: center; margin-top: 3mm; font-size: 8px; color: #555; }
      </style></head><body>${bodyHtml}</body></html>`;
  }

  /**
   * Prints an HTML ticket via the system print dialog.
   * The document title carries the printer name so the user can route it
   * to the correct physical printer.
   */
  printDialog(title, html) {
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
    doc.write(this._buildDialogDoc(title, html));
    doc.close();

    setTimeout(() => {
      iframe.contentWindow.focus();
      iframe.contentWindow.print();
      setTimeout(() => document.body.removeChild(iframe), 1500);
    }, 250);
  }

  /**
   * Prints a kitchen ticket (only the newly-added items) to one printer.
   */
  async printKitchenTicket(printer, ticket) {
    const lines = [];
    lines.push({ t: 'أمر مطبخ', c: true, b: true, s: true });
    lines.push({ t: `طاولة ${ticket.tableNumber}`, c: true, b: true });
    lines.push({ t: `الوقت: ${ticket.time}`, c: true });
    lines.push({ empty: true });
    for (const item of ticket.items) {
      lines.push({ t: String(item.name), l: 'x' + item.qty, b: true });
    }
    lines.push({ empty: true });
    if (ticket.customerName) lines.push({ t: `زبون: ${ticket.customerName}` });
    lines.push({ t: `# ${ticket.orderId || ''}`, c: true });
    lines.push({ t: '------------------', c: true });

    const itemsHtml = ticket.items.map(it => `
      <div class="row">
        <span>${escapeHtml(it.name)}</span>
        <span class="qty">×${it.qty}</span>
      </div>`).join('');
    const html = `
      <div class="ticket-header">
        <h2>أمر مطبخ</h2>
        <div style="display:flex; justify-content:center; font-weight:700;">طاولة ${ticket.tableNumber}</div>
        <div style="display:flex; justify-content:center; font-size:11px;">الوقت: ${ticket.time}</div>
      </div>
      <div class="divider"></div>
      <div class="items-table">${itemsHtml}</div>
      <div class="divider"></div>
      <div class="footer">${ticket.customerName ? 'زبون: ' + escapeHtml(ticket.customerName) : ''}&nbsp;</div>`;

    await this._routeLines(printer, lines, `طابعة المطبخ: ${printer.name}`, html);
  }

  /**
   * Prints an item cancellation ticket (for canceled/reduced items) to one kitchen/bar printer.
   */
  async printKitchenCancellationTicket(printer, ticket) {
    const lines = [];
    lines.push({ t: '*** إلغاء صنف ***', c: true, b: true, s: true });
    lines.push({ t: `طاولة ${ticket.tableNumber}`, c: true, b: true });
    lines.push({ t: `الوقت: ${ticket.time}`, c: true });
    lines.push({ empty: true });
    for (const item of ticket.items) {
      lines.push({ t: `[ملغى] ${item.name}`, l: 'x' + item.qty, b: true });
    }
    lines.push({ empty: true });
    if (ticket.customerName) lines.push({ t: `زبون: ${ticket.customerName}` });
    lines.push({ t: `# ${ticket.orderId || ''}`, c: true });
    lines.push({ t: '------------------', c: true });

    const itemsHtml = ticket.items.map(it => `
      <div class="row" style="color: #dc2626; font-weight: bold;">
        <span>[ملغى] ${escapeHtml(it.name)}</span>
        <span class="qty">×${it.qty}</span>
      </div>`).join('');
    const html = `
      <div class="ticket-header" style="border-bottom: 2px dashed #dc2626;">
        <h2 style="color: #dc2626; text-align: center;">*** إلغاء صنف ***</h2>
        <div style="display:flex; justify-content:center; font-weight:700;">طاولة ${ticket.tableNumber}</div>
        <div style="display:flex; justify-content:center; font-size:11px;">الوقت: ${ticket.time}</div>
      </div>
      <div class="divider"></div>
      <div class="items-table">${itemsHtml}</div>
      <div class="divider"></div>
      <div class="footer">${ticket.customerName ? 'زبون: ' + escapeHtml(ticket.customerName) : ''}&nbsp;</div>`;

    await this._routeLines(printer, lines, `طابعة المطبخ (إلغاء): ${printer.name}`, html);
  }

  /**
   * Prints a customer receipt (main printer).
   */
  async printMainReceipt(printer, sale, invoiceId) {
    const formattedInvoiceId = 'Bis-' + String(invoiceId || sale.id).padStart(6, '0');
    const formattedDate = new Date(sale.timestamp || sale.endTime || Date.now()).toLocaleString('ar-SY');
    const rawMethod = String(sale.paymentMethod || '').toLowerCase().trim();
    const displayMethod = (rawMethod.includes('card') || rawMethod.includes('bank') || rawMethod.includes('شبكة') || rawMethod.includes('بطاقة') || rawMethod.includes('مدى')) ? 'بنك' : 'كاش';
    const oldLira = Math.round(sale.total * 100).toLocaleString('en-US');

    const lines = [];
    lines.push({ t: state.restaurantName || 'Restaurant', c: true, b: true, s: true });
    lines.push({ t: state.restaurantSlogan || '', c: true });
    lines.push({ empty: true });
    lines.push({ t: '------------------', c: true });
    lines.push({ t: 'رقم الفاتورة:', l: formattedInvoiceId });
    lines.push({ t: 'طاولة:', l: String(sale.tableNumber) });
    lines.push({ t: 'زبون:', l: sale.customerName || 'زبون عام' });
    lines.push({ t: 'طريقة الدفع:', l: displayMethod });
    lines.push({ t: 'التاريخ:', l: formattedDate });
    lines.push({ t: '------------------', c: true });
    for (const item of sale.items) {
      const originalTotal = item.price * item.quantity;
      if (item.isHospitality) {
        lines.push({ t: String(item.name), l: `x${item.quantity} (ضيافة) 0`, b: true });
      } else {
        lines.push({ t: String(item.name), l: `x${item.quantity} ${formatCurrency(originalTotal)}`, b: true });
      }
    }
    lines.push({ t: '------------------', c: true });
    lines.push({ t: 'المجموع الفرعي:', l: formatCurrency(sale.subtotal) });
    if (sale.discount > 0) lines.push({ t: 'الحسم:', l: '-' + formatCurrency(sale.discount) });
    lines.push({ t: 'المجموع النهائي:', l: formatCurrency(sale.total), b: true });
    lines.push({ t: `(السعر بالليرة القديمة: ${oldLira})`, c: true });
    if (sale.currencyType === 'dollar' && sale.dollarTotal) {
      lines.push({ t: 'المدفوع بالدولار:', l: '$' + sale.dollarTotal, b: true });
      lines.push({ t: 'سعر الصرف:', l: String(sale.exchangeRate) });
    }
    lines.push({ t: '------------------', c: true });
    lines.push({ t: state.restaurantFooter || '', c: true });

    const itemsHtml = sale.items.map(item => {
      const originalTotal = item.price * item.quantity;
      if (item.isHospitality) {
        return `<div class="row"><span>${escapeHtml(item.name)} <span style="font-size:10px; border:1px solid #000; border-radius:3px; padding:0 3px;">ضيافة</span></span><span><s>${formatCurrency(originalTotal)}</s> 0 ل.س</span></div>`;
      }
      return `<div class="row"><span>${escapeHtml(item.name)} (x${item.quantity})</span><span>${formatCurrency(originalTotal)}</span></div>`;
    }).join('');
    const discountHtml = sale.discount > 0
      ? `<div class="row" style="color:#c0392b; font-weight:700;"><span>الحسم الإضافي:</span><span>-${formatCurrency(sale.discount)}</span></div>`
      : '';
    const dollarHtml = (sale.currencyType === 'dollar' && sale.dollarTotal)
      ? `<div class="row" style="font-weight:700;"><span>المدفوع بالدولار ($):</span><span>$${sale.dollarTotal}</span></div><div style="text-align:center; font-size:8px; color:#555;">سعر الصرف: ${sale.exchangeRate} ل.س</div>`
      : '';

    const html = `
      <div class="ticket-header">
        <h2>${escapeHtml(state.restaurantName || 'Restaurant')}</h2>
        <p style="font-style:italic; font-size:11px;">${escapeHtml(state.restaurantSlogan || '')}</p>
      </div>
      <div class="divider"></div>
      <div class="row"><span>رقم الفاتورة:</span><span style="font-weight:700;">${formattedInvoiceId}</span></div>
      <div class="row"><span>طاولة:</span><span>${sale.tableNumber}</span></div>
      <div class="row"><span>زبون:</span><span>${escapeHtml(sale.customerName || 'زبون عام')}</span></div>
      <div class="row"><span>طريقة الدفع:</span><span>${displayMethod}</span></div>
      <div class="row"><span>التاريخ:</span><span>${formattedDate}</span></div>
      <div class="divider"></div>
      <div class="items-table">${itemsHtml}</div>
      <div class="divider"></div>
      <div class="row"><span>المجموع الفرعي:</span><span>${formatCurrency(sale.subtotal)}</span></div>
      ${discountHtml}
      <div class="row" style="font-weight:800; font-size:12px; border-top:1px dashed #000; padding-top:1.5mm; margin-top:1mm;"><span>المجموع النهائي:</span><span>${formatCurrency(sale.total)}</span></div>
      <div style="text-align:center; font-size:8px; color:#555;">(السعر بالليرة القديمة: ${oldLira} ل.س)</div>
      ${dollarHtml}
      <div class="divider"></div>
      <div class="footer">${escapeHtml(state.restaurantFooter || '')}</div>`;

    await this._routeLines(printer, lines, `طابعة الفواتير: ${printer.name}`, html);
  }
}

const printManager = new PrintManager();

// --- Kitchen ticket routing logic ---

function getActiveKitchenPrinters() {
  return (state.printers || []).filter(p => (p.type === 'kitchen' || p.type === 'bar') && p.active);
}

function printerMatchesItem(printer, item) {
  if (printer.assignment === 'all') return true;
  if (printer.assignment === 'categories') {
    const prod = state.products.find(p => p.id === item.productId);
    return !!(prod && printer.categoryIds && printer.categoryIds.includes(prod.categoryId));
  }
  if (printer.assignment === 'products') {
    return !!(printer.productIds && printer.productIds.includes(item.productId));
  }
  return true;
}

function getUnprintedItems(items) {
  return items.map((item, idx) => ({ item, idx }))
    .filter(({ item }) => (item.quantity || 0) > (item.printedQty || 0));
}

/**
 * Prints kitchen tickets for the newly-added (unprinted) items of the currently
 * selected table. Returns the set of item indexes that were successfully printed.
 */
async function printKitchenTickets(items) {
  const kitchenPrinters = getActiveKitchenPrinters();
  const printedIdx = new Set();
  if (kitchenPrinters.length === 0 || !items || items.length === 0) return printedIdx;

  const table = state.tables.find(t => t.id === state.selectedTableId);
  const unprinted = getUnprintedItems(items);
  if (unprinted.length === 0) return printedIdx;

  const ticket = {
    tableNumber: table ? table.number : '',
    time: new Date().toLocaleTimeString('ar-SY', { hour: '2-digit', minute: '2-digit' }),
    customerName: state.currentCart.customerName || '',
    orderId: new Date().toLocaleTimeString('ar-SY', { hour: '2-digit', minute: '2-digit', second: '2-digit' })
  };

  // 1. Route items to the kitchen printers matching their assignment
  const handled = new Set();
  for (const printer of kitchenPrinters) {
    const assigned = unprinted.filter(({ item }) => printerMatchesItem(printer, item));
    if (assigned.length === 0) continue;
    try {
      await printManager.printKitchenTicket(printer, {
        ...ticket,
        items: assigned.map(({ item }) => ({ name: item.name, qty: item.quantity - (item.printedQty || 0) }))
      });
      assigned.forEach(({ idx }) => { printedIdx.add(idx); handled.add(idx); });
    } catch (err) {
      console.error(`Kitchen print failed on "${printer.name}":`, err);
    }
  }

  // 2. Leftovers (items that matched no kitchen printer) go to the first active kitchen printer
  const leftovers = unprinted.filter(({ idx }) => !handled.has(idx));
  if (leftovers.length > 0) {
    const fallback = kitchenPrinters[0];
    try {
      await printManager.printKitchenTicket(fallback, {
        ...ticket,
        items: leftovers.map(({ item }) => ({ name: item.name, qty: item.quantity - (item.printedQty || 0) }))
      });
      leftovers.forEach(({ idx }) => printedIdx.add(idx));
    } catch (err) {
      console.error('Fallback kitchen print failed:', err);
    }
  }

  return printedIdx;
}

function markItemsPrinted(items, printedIdx) {
  printedIdx.forEach(idx => {
    if (items[idx]) items[idx].printedQty = items[idx].quantity;
  });
}

/**
 * Auto-print hook: prints newly-added items for the selected table and marks them.
 * Called from saveCurrentOrderState, markTableForBilling and executeCheckout.
 */
async function printKitchenAuto() {
  if (!state.selectedTableId) return;
  const order = (state.activeOrders || {})[state.selectedTableId];
  if (!order || !order.items) return;
  const printedIdx = await printKitchenTickets(order.items);
  if (printedIdx.size > 0) markItemsPrinted(order.items, printedIdx);
}

/**
 * Routes canceled items to their assigned kitchen/bar printers.
 */
async function printKitchenCancellationTickets(canceledItems, tableNumber, customerName) {
  const kitchenPrinters = getActiveKitchenPrinters();
  if (kitchenPrinters.length === 0 || !canceledItems || canceledItems.length === 0) return;

  const ticket = {
    tableNumber: tableNumber || '',
    time: new Date().toLocaleTimeString('ar-SY', { hour: '2-digit', minute: '2-digit' }),
    customerName: customerName || '',
    orderId: new Date().toLocaleTimeString('ar-SY', { hour: '2-digit', minute: '2-digit', second: '2-digit' })
  };

  const handled = new Set();
  for (const printer of kitchenPrinters) {
    const assigned = canceledItems.filter(item => printerMatchesItem(printer, item));
    if (assigned.length === 0) continue;
    try {
      await printManager.printKitchenCancellationTicket(printer, {
        ...ticket,
        items: assigned.map(item => ({ name: item.name, qty: item.canceledQty }))
      });
      assigned.forEach(item => handled.add(item.productId));
    } catch (err) {
      console.error(`Kitchen cancellation print failed on "${printer.name}":`, err);
    }
  }

  const leftovers = canceledItems.filter(item => !handled.has(item.productId));
  if (leftovers.length > 0) {
    const fallback = kitchenPrinters[0];
    try {
      await printManager.printKitchenCancellationTicket(fallback, {
        ...ticket,
        items: leftovers.map(item => ({ name: item.name, qty: item.canceledQty }))
      });
    } catch (err) {
      console.error('Fallback kitchen cancellation print failed:', err);
    }
  }
}

/**
 * Compares previously printed items with new items to detect and print cancellations.
 * Returns the list of canceled items so callers can sync printedQty.
 */
async function detectAndPrintCanceledItems(tableId, oldItems, newItems) {
  if (!oldItems || oldItems.length === 0) return [];
  const table = state.tables.find(t => t.id === tableId);
  const tableNumber = table ? table.number : '';
  const customerName = state.currentCart.customerName || '';

  const canceledList = [];

  oldItems.forEach(oldItem => {
    const printedQty = oldItem.printedQty || 0;
    if (printedQty > 0) {
      const newItem = (newItems || []).find(n => n.productId === oldItem.productId);
      const newQty = newItem ? newItem.quantity : 0;
      if (newQty < printedQty) {
        canceledList.push({
          productId: oldItem.productId,
          name: oldItem.name,
          canceledQty: printedQty - newQty,
          price: oldItem.price
        });
      }
    }
  });

  if (canceledList.length > 0) {
    await printKitchenCancellationTickets(canceledList, tableNumber, customerName);
  }

  return canceledList;
}

/**
 * Manual "print kitchen tickets" button (prints only items not yet printed).
 */
async function printKitchenTicketsManual() {
  if (!state.selectedTableId) return;
  const order = (state.activeOrders || {})[state.selectedTableId];
  if (!order || !order.items || order.items.length === 0) {
    alert('لا توجد طلبات مسجلة لهذه الطاولة.');
    return;
  }

  if (getActiveKitchenPrinters().length === 0) {
    alert('لا توجد طابعة مطبخ أو بار نشطة. أضف طابعة من نوع "مطبخ" أو "بار" من إعدادات النظام أولاً.');
    return;
  }

  const printedIdx = await printKitchenTickets(order.items);
  if (printedIdx.size === 0) {
    if (getUnprintedItems(order.items).length === 0) {
      alert('لا توجد أصناف جديدة غير مطبوعة لهذه الطاولة. كل الأصناف مطبوعة بالفعل.');
    } else {
      alert('فشلت الطباعة. تحقق من اتصال الطابعة وحاول مجدداً.');
    }
    return;
  }

  markItemsPrinted(order.items, printedIdx);
  state.currentCart.items = order.items;
  // Sync the saved snapshot so later reductions/cancellations compute correct deltas
  state.lastSavedItems[state.selectedTableId] = JSON.parse(JSON.stringify(order.items));
  await state.db.saveActiveOrder(state.selectedTableId, order).catch(err =>
    console.error('Save printed state failed:', err)
  );
  alert('تم إرسال تذاكر المطبخ بنجاح.');
}

/**
 * Routes a sale receipt to the configured main printers (USB or dialog).
 * Falls back to the default receipt printer when no main printer is configured.
 */
async function printReceiptToMainPrinters(sale, invoiceId) {
  const mains = (state.printers || []).filter(p => p.type === 'main' && p.active);
  if (mains.length === 0) {
    printReceiptSlipDirectly(sale, invoiceId);
    return;
  }
  let anySucceeded = false;
  for (const printer of mains) {
    try {
      await printManager.printMainReceipt(printer, sale, invoiceId);
      anySucceeded = true;
    } catch (err) {
      console.error(`Main receipt print failed on "${printer.name}":`, err);
    }
  }
  if (!anySucceeded) {
    printReceiptSlipDirectly(sale, invoiceId);
  }
}

// --- Printers CRUD (Settings) ---

function renderPrintersList() {
  const container = document.getElementById('printers-list');
  if (!container) return;
  container.innerHTML = '';

  const printers = state.printers || [];
  if (printers.length === 0) {
    container.innerHTML = `<div class="loading-placeholder" style="padding: 15px; text-align: center;">لا توجد طابعات مضافة بعد. أضف طابعة مطبخ أو رئيسية للبدء بالطباعة المتعددة.</div>`;
    return;
  }

  printers.forEach(printer => {
    const card = document.createElement('div');
    card.style.cssText = 'border:1px solid var(--border-light); border-radius:10px; padding:12px 14px; margin-bottom:10px; background: var(--bg-card, #ffffff); display:flex; align-items:center; justify-content:space-between; gap:10px; flex-wrap:wrap;';

    let typeTxt = 'مطبخ (تذاكر)';
    let typeColor = '#193B23';
    let typeBadge = 'occupied';
    if (printer.type === 'bar') { typeTxt = 'بار (تذاكر)'; typeColor = '#3498db'; typeBadge = 'billing'; }
    else if (printer.type === 'main') { typeTxt = 'رئيسية (إيصال)'; typeColor = '#d4af37'; typeBadge = 'billing'; }

    let connTxt = 'نافذة الطباعة';
    if (printer.connection === 'usb') connTxt = 'USB مباشر';
    else if (printer.connection === 'network') connTxt = `شبكة IP: ${escapeHtml(printer.ip || '')}` + (printer.port && printer.port !== 9100 ? ':' + printer.port : '');
    else if (printer.connection === 'windows') connTxt = 'ويندوز: ' + escapeHtml(printer.windowsDeviceName || '');
    let assignmentTxt = 'كل الأصناف';
    if (printer.assignment === 'categories') assignmentTxt = 'تصنيفات محددة';
    else if (printer.assignment === 'products') assignmentTxt = 'منتجات محددة';

    card.innerHTML = `
      <div style="display:flex; align-items:center; gap:12px; flex:1; min-width:200px;">
        <div style="width:42px; height:42px; border-radius:10px; background:${printer.type === 'main' ? 'rgba(212,175,55,0.12)' : printer.type === 'bar' ? 'rgba(52,152,219,0.12)' : 'rgba(25,59,35,0.10)'}; display:flex; align-items:center; justify-content:center; flex-shrink:0;">
          <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="${typeColor}" stroke-width="2"><polyline points="6 9 6 2 18 2 18 9"/><path d="M6 18H4a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2h-2"/><rect x="6" y="14" width="12" height="8"/></svg>
        </div>
        <div>
          <div style="display:flex; align-items:center; gap:8px; flex-wrap:wrap;">
            <strong style="font-size:14px;">${escapeHtml(printer.name)}</strong>
            <span class="badge-status ${typeBadge}" style="font-size:10px; padding:2px 8px; border-radius:10px;">${typeTxt}</span>
          </div>
          <div style="font-size:12px; color:var(--text-muted); margin-top:3px;">
            ${connTxt} • ${assignmentTxt} • نسخ: ${printer.copies || 1}
            ${printer.connection === 'usb' && printer.usbDevice ? ` • <span style="color:#10b981;">${escapeHtml(printer.usbDevice.productName || 'متصل')}</span>` : ''}
          </div>
        </div>
      </div>
      <div style="display:flex; gap:6px; align-items:center; flex-wrap:wrap;">
        <label style="display:flex; align-items:center; gap:5px; font-size:12px; cursor:pointer;">
          <input type="checkbox" ${printer.active ? 'checked' : ''} onchange="togglePrinterActive('${printer.id}')">
          مفعّل
        </label>
        <button class="btn btn-secondary btn-xs" onclick="testPrintPrinter('${printer.id}')" title="طباعة تجريبية">تجربة</button>
        <button class="btn btn-secondary btn-xs" onclick="openEditPrinterModal('${printer.id}')">تعديل</button>
        <button class="btn btn-danger-outline btn-xs" onclick="deletePrinter('${printer.id}')">حذف</button>
      </div>`;
    container.appendChild(card);
  });
}

function setUsbDeviceOnForm(device) {
  const info = {
    vendorId: device.vendorId,
    productId: device.productId,
    serialNumber: device.serialNumber || '',
    productName: device.productName || 'طابعة USB حرارية'
  };
  document.getElementById('printer-form-usb-json').value = JSON.stringify(info);
  document.querySelector('input[name="printer-connection"][value="usb"]').checked = true;
  document.getElementById('printer-usb-device-box').style.display = 'block';
  document.getElementById('printer-usb-device-name').textContent = info.productName;
  updatePrinterTypeUI();
}

async function pairUsbPrinter() {
  if (!printManager.usbSupported) {
    alert('المتصفح الحالي لا يدعم الربط المباشر USB.\nاستخدم متصفح Chrome أو Edge على اتصال آمن (HTTPS) مع طابعة حرارية 58mm أو 80mm.');
    return;
  }
  try {
    const device = await printManager.requestUsbDevice();
    openAddPrinterModal(device);
  } catch (err) {
    if (err && err.name === 'NotFoundError') return; // User cancelled the chooser
    console.error('USB pairing failed:', err);
    alert('فشل ربط الطابعة: ' + (err && err.message ? err.message : err));
  }
}

function updatePrinterTypeUI() {
  const type = document.querySelector('input[name="printer-type"]:checked').value;
  const connection = document.querySelector('input[name="printer-connection"]:checked').value;
  const isKitchen = type === 'kitchen' || type === 'bar';
  const assignmentBox = document.getElementById('printer-assignment-box');
  if (assignmentBox) assignmentBox.style.display = isKitchen ? 'block' : 'none';

  const usbBox = document.getElementById('printer-usb-device-box');
  if (usbBox) {
    if (connection === 'usb') {
      usbBox.style.display = 'block';
    } else if (!document.getElementById('printer-form-usb-json').value) {
      usbBox.style.display = 'none';
    }
  }

  const networkBox = document.getElementById('printer-network-fields');
  if (networkBox) networkBox.style.display = connection === 'network' ? 'block' : 'none';

  const windowsBox = document.getElementById('printer-windows-fields');
  if (windowsBox) windowsBox.style.display = connection === 'windows' ? 'block' : 'none';

  updatePrinterAssignmentUI();
}

/**
 * Populates the Windows printers dropdown from the Electron main process.
 */
async function populateWindowsPrinters(selectedDevice = '') {
  const select = document.getElementById('printer-form-windows-device');
  if (!select) return;
  const hint = document.getElementById('printer-windows-note');
  if (!isElectron) {
    if (hint) hint.style.display = 'block';
    select.innerHTML = '<option value="">غير متاح في المتصفح</option>';
    return;
  }
  if (hint) hint.style.display = 'none';
  select.innerHTML = '<option value="">جاري تحميل الطابعات...</option>';
  try {
    const printers = await window.bistroPrint.listPrinters();
    if (!printers || printers.length === 0) {
      select.innerHTML = '<option value="">لا توجد طابعات مثبتة في Windows</option>';
      return;
    }
    let options = '';
    printers.forEach(p => {
      const name = p.name || '';
      // Chromium status: 0=idle, 1=busy, 2=unavailable, 3=error, 4=unknown
      const disconnected = (p.status === 2 || p.status === 3);
      const label = (p.displayName || name) + (disconnected ? ' (غير متصلة)' : '');
      options += `<option value="${name.replace(/"/g, '&quot;')}">${escapeHtml(label)}</option>`;
    });
    select.innerHTML = options || '<option value="">لا توجد طابعات</option>';
    if (selectedDevice) {
      select.value = selectedDevice;
      if (select.value !== selectedDevice) select.value = '';
    }
  } catch (err) {
    console.error('Failed to load Windows printers:', err);
    select.innerHTML = '<option value="">فشل تحميل الطابعات</option>';
  }
}

window.populateWindowsPrinters = populateWindowsPrinters;

function updatePrinterAssignmentUI() {
  const assignment = document.querySelector('input[name="printer-assignment"]:checked')?.value || 'all';
  const catBox = document.getElementById('printer-categories-box');
  const prodBox = document.getElementById('printer-products-box');
  if (catBox) catBox.style.display = assignment === 'categories' ? 'block' : 'none';
  if (prodBox) prodBox.style.display = assignment === 'products' ? 'block' : 'none';
}

function populatePrinterChecklists(printer = null) {
  const catBox = document.getElementById('printer-categories-checkboxes');
  if (catBox) {
    catBox.innerHTML = '';
    if ((state.categories || []).length === 0) {
      catBox.innerHTML = '<div style="font-size:12px; color:var(--text-muted);">لا توجد تصنيفات بعد.</div>';
    }
    state.categories.forEach(cat => {
      const label = document.createElement('label');
      label.style.cssText = 'display:flex; align-items:center; gap:6px; padding:4px 2px; font-size:13px; cursor:pointer;';
      const cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.value = cat.id;
      cb.checked = !!(printer && printer.categoryIds && printer.categoryIds.includes(cat.id));
      label.appendChild(cb);
      label.appendChild(document.createTextNode(cat.name));
      catBox.appendChild(label);
    });
  }

  const prodBox = document.getElementById('printer-products-checkboxes');
  if (prodBox) {
    prodBox.innerHTML = '';
    if ((state.products || []).length === 0) {
      prodBox.innerHTML = '<div style="font-size:12px; color:var(--text-muted);">لا توجد منتجات بعد.</div>';
    }
    state.products.forEach(prod => {
      const label = document.createElement('label');
      label.style.cssText = 'display:flex; align-items:center; gap:6px; padding:4px 2px; font-size:13px; cursor:pointer;';
      const cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.value = prod.id;
      cb.checked = !!(printer && printer.productIds && printer.productIds.includes(prod.id));
      label.appendChild(cb);
      label.appendChild(document.createTextNode(prod.name));
      prodBox.appendChild(label);
    });
  }
}

function openAddPrinterModal(usbDevice = null) {
  document.getElementById('printer-form-id').value = '';
  document.getElementById('printer-form-name').value = '';
  document.getElementById('printer-form-copies').value = '1';
  document.querySelector('input[name="printer-type"][value="kitchen"]').checked = true;
  document.querySelector('input[name="printer-assignment"][value="all"]').checked = true;
  document.getElementById('printer-modal-title').textContent = 'إضافة طابعة جديدة';
  document.getElementById('printer-form-ip').value = '';
  document.getElementById('printer-form-port').value = '9100';

  if (usbDevice) {
    setUsbDeviceOnForm(usbDevice);
  } else {
    document.getElementById('printer-form-usb-json').value = '';
    document.querySelector('input[name="printer-connection"][value="dialog"]').checked = true;
    document.getElementById('printer-usb-device-box').style.display = 'none';
  }

  updatePrinterTypeUI();
  populatePrinterChecklists();
  populateWindowsPrinters('');
  openModal('modal-printer');
  document.getElementById('printer-form-name').focus();
}

function openEditPrinterModal(id) {
  const printer = (state.printers || []).find(p => p.id === id);
  if (!printer) return;

  document.getElementById('printer-form-id').value = printer.id;
  document.getElementById('printer-form-name').value = printer.name || '';
  document.getElementById('printer-form-copies').value = printer.copies || 1;
  document.querySelector(`input[name="printer-type"][value="${printer.type || 'kitchen'}"]`).checked = true;
  document.querySelector(`input[name="printer-connection"][value="${printer.connection || 'dialog'}"]`).checked = true;
  document.querySelector(`input[name="printer-assignment"][value="${printer.assignment || 'all'}"]`).checked = true;
  document.getElementById('printer-form-usb-json').value = printer.usbDevice ? JSON.stringify(printer.usbDevice) : '';
  document.getElementById('printer-form-ip').value = printer.ip || '';
  document.getElementById('printer-form-port').value = printer.port || '9100';

  if (printer.usbDevice) {
    document.getElementById('printer-usb-device-box').style.display = 'block';
    document.getElementById('printer-usb-device-name').textContent = printer.usbDevice.productName || 'جهاز مقترن';
  } else {
    document.getElementById('printer-usb-device-box').style.display = 'none';
  }

  document.getElementById('printer-modal-title').textContent = 'تعديل بيانات الطابعة';
  updatePrinterTypeUI();
  populatePrinterChecklists(printer);
  populateWindowsPrinters(printer.windowsDeviceName || '');
  openModal('modal-printer');
  document.getElementById('printer-form-name').focus();
}

async function submitPrinterForm() {
  const id = document.getElementById('printer-form-id').value;
  const name = document.getElementById('printer-form-name').value.trim();
  const type = document.querySelector('input[name="printer-type"]:checked').value;
  const connection = document.querySelector('input[name="printer-connection"]:checked').value;
  const copies = parseInt(document.getElementById('printer-form-copies').value) || 1;
  const assignment = document.querySelector('input[name="printer-assignment"]:checked')?.value || 'all';

  if (!name) {
    alert('يرجى إدخال اسم الطابعة.');
    return;
  }

  const usbJson = document.getElementById('printer-form-usb-json').value;
  if (connection === 'usb' && !usbJson) {
    alert('طريقة الطباعة USB تتطلب ربط الطابعة أولاً. اضغط "ربط طابعة USB" في شاشة الإعدادات لاختيار الجهاز.');
    return;
  }

  const ip = document.getElementById('printer-form-ip').value.trim();
  if (connection === 'network' && !ip) {
    alert('يرجى إدخال عنوان IP للطابعة على الشبكة.');
    return;
  }

  const windowsDeviceName = document.getElementById('printer-form-windows-device').value;
  if (connection === 'windows' && !windowsDeviceName) {
    alert('يرجى اختيار الطابعة المثبتة في Windows. هذا الخيار متاح فقط في نسخة التطبيق (exe).');
    return;
  }

  const categoryIds = Array.from(document.querySelectorAll('#printer-categories-checkboxes input[type="checkbox"]:checked')).map(cb => cb.value);
  const productIds = Array.from(document.querySelectorAll('#printer-products-checkboxes input[type="checkbox"]:checked')).map(cb => cb.value);

  const payload = {
    name,
    type,
    connection,
    copies,
    assignment,
    active: true,
    categoryIds: assignment === 'categories' ? categoryIds : [],
    productIds: assignment === 'products' ? productIds : []
  };
  if (connection === 'usb') payload.usbDevice = JSON.parse(usbJson);
  if (connection === 'network') {
    payload.ip = ip;
    payload.port = parseInt(document.getElementById('printer-form-port').value) || 9100;
  }
  if (connection === 'windows') {
    payload.windowsDeviceName = windowsDeviceName;
  }
  if (id) {
    payload.id = id;
    const existing = (state.printers || []).find(p => p.id === id);
    if (existing) payload.active = existing.active;
  }

  await state.db.savePrinter(payload);
  closeModal('modal-printer');
  await refreshStateData({ printers: true });
  renderPrintersList();
  alert('تم حفظ الطابعة بنجاح.');
}

async function deletePrinter(id) {
  const printer = (state.printers || []).find(p => p.id === id);
  if (!printer) return;
  if (!confirm(`هل أنت متأكد من حذف الطابعة "${printer.name}"؟`)) return;
  await state.db.deletePrinter(id);
  await refreshStateData({ printers: true });
  renderPrintersList();
}

async function togglePrinterActive(id) {
  const printer = (state.printers || []).find(p => p.id === id);
  if (!printer) return;
  printer.active = !printer.active;
  await state.db.savePrinter(printer);
  await refreshStateData({ printers: true });
  renderPrintersList();
}

async function testPrintPrinter(id) {
  const printer = (state.printers || []).find(p => p.id === id);
  if (!printer) return;
  const lines = [
    { t: 'Bistro POS', c: true, b: true, s: true },
    { t: 'طباعة تجريبية', c: true, b: true },
    { t: `الطابعة: ${printer.name}`, c: true },
    { t: new Date().toLocaleString('ar-SY'), c: true },
    { t: 'إذا ظهرت هذه الرسالة فالطابعة تعمل بشكل صحيح', c: true }
  ];
  const html = `
    <div class="ticket-header">
      <h2>Bistro POS</h2>
      <h3 style="margin:4px 0;">طباعة تجريبية</h3>
      <div style="display:flex; justify-content:center;">${escapeHtml(printer.name)}</div>
      <div style="display:flex; justify-content:center;">${new Date().toLocaleString('ar-SY')}</div>
    </div>
    <div class="divider"></div>
    <div class="footer">إذا ظهرت هذه الرسالة فكل شيء يعمل بشكل صحيح.</div>`;
  try {
    await printManager._routeLines(printer, lines, `طابعة تجريبية: ${printer.name}`, html);
    alert('تم إرسال الطباعة التجريبية إلى الطابعة بنجاح.');
  } catch (err) {
    console.error('Test print failed:', err);
    alert('فشلت الطباعة التجريبية: ' + (err && err.message ? err.message : err));
  }
}

/**
 * Saves the print bridge server URL (global setting).
 */
async function savePrintBridgeUrl() {
  if (isElectron) {
    alert('في نسخة التطبيق (exe) لا حاجة لسيرفر وسيط — الطباعة تتم مباشرة.');
    return;
  }
  const input = document.getElementById('settings-print-bridge-url');
  const value = (input ? input.value : '').trim();
  if (!value) {
    alert('يرجى إدخال عنوان سيرفر الطباعة، مثال: http://192.168.1.50:6333');
    return;
  }
  try {
    await state.db.put('settings', { id: 'print_bridge_url', value });
    state.printBridgeUrl = value;
    alert('تم حفظ عنوان سيرفر الطباعة بنجاح.');
  } catch (err) {
    console.error('Failed to save print bridge URL:', err);
    alert('حدث خطأ أثناء الحفظ: ' + (err && err.message ? err.message : err));
  }
}

/**
 * Sends a health check to the print bridge server.
 */
async function testPrintBridge() {
  if (isElectron) {
    alert('في نسخة التطبيق (exe) لا حاجة لسيرفر وسيط — الطباعة عبر الشبكة تتم مباشرة من التطبيق.');
    return;
  }
  const input = document.getElementById('settings-print-bridge-url');
  const bridge = (input ? input.value : '').trim().replace(/\/+$/, '');
  if (!bridge) {
    alert('أدخل عنوان سيرفر الطباعة أولاً.');
    return;
  }
  try {
    const res = await fetch(bridge + '/health', { method: 'GET' }).catch(() => null);
    if (!res || !res.ok) throw new Error('HTTP ' + (res ? res.status : 'تعذر الاتصال'));
    const data = await res.json().catch(() => ({}));
    if (data.ok) {
      alert('السيرفر الوسيط يعمل بنجاح. جاهز لاستقبال أوامر الطباعة.');
    } else {
      throw new Error('استجابة غير متوقعة');
    }
  } catch (err) {
    console.error('Print bridge health check failed:', err);
    alert('فشل الاتصال بسيرفر الطباعة الوسيط.\nتأكد من تشغيله على جهاز الكاشير: node print-server.js\n' + (err && err.message ? err.message : ''));
  }
}

// Expose printer functions globally
window.printKitchenTicketsManual = printKitchenTicketsManual;
window.printKitchenAuto = printKitchenAuto;
window.printReceiptToMainPrinters = printReceiptToMainPrinters;
window.renderPrintersList = renderPrintersList;
window.openAddPrinterModal = openAddPrinterModal;
window.openEditPrinterModal = openEditPrinterModal;
window.submitPrinterForm = submitPrinterForm;
window.deletePrinter = deletePrinter;
window.togglePrinterActive = togglePrinterActive;
window.testPrintPrinter = testPrintPrinter;
window.pairUsbPrinter = pairUsbPrinter;
window.updatePrinterTypeUI = updatePrinterTypeUI;
window.updatePrinterAssignmentUI = updatePrinterAssignmentUI;
window.savePrintBridgeUrl = savePrintBridgeUrl;
window.testPrintBridge = testPrintBridge;
window.updatePrinterAssignmentUI = updatePrinterAssignmentUI;