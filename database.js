/**
 * Bistro POS - Database Management Module (Pure Firebase Firestore Driver)
 * Works 100% serverless client-side using Firebase Firestore with native IndexedDB
 * offline persistence enabled for seamless operation without internet, auto-syncing
 * when internet connection is active.
 */

// --- Firebase Configuration ---
// TO DEV: Replace these placeholder credentials with your actual Firebase project credentials.
const firebaseConfig = {
  apiKey: "AIzaSyAMfL-4qhO3y4ia43nTFrhRUsxJGE5ZiO0",
  authDomain: "bistro-aleppo-pos.firebaseapp.com",
  projectId: "bistro-aleppo-pos",
  storageBucket: "bistro-aleppo-pos.firebasestorage.app",
  messagingSenderId: "739729190708",
  appId: "1:739729190708:web:6d833798d555401099bf61",
  measurementId: "G-K1RPMRCLMY"
};

class BistroDatabase {
  constructor() {
    this.firestore = null;
  }

  /**
   * Initializes the database connection.
   * Connects to Firebase Firestore with offline persistence enabled.
   * Resolves true if connected successfully, false if Firebase is not yet configured.
   */
  init() {
    return new Promise(async (resolve) => {
      // Elegant validation check for default placeholders
      if (!firebaseConfig.apiKey || firebaseConfig.apiKey === "YOUR_API_KEY") {
        console.error("Firebase configuration has not been set in database.js!");
        resolve(false);
        return;
      }

      try {
        // Prevent double initialization
        if (!firebase.apps.length) {
          firebase.initializeApp(firebaseConfig);
        }

        // Configure offline persistence for Firestore so it works client-side offline too!
        try {
          await firebase.firestore().enablePersistence({ synchronizeTabs: true });
          console.log('Firestore offline persistence enabled successfully.');
        } catch (err) {
          if (err.code === 'failed-precondition') {
            console.warn('Firestore persistence failed-precondition (multiple tabs open).');
          } else if (err.code === 'unimplemented') {
            console.warn('Firestore persistence is unimplemented in this browser.');
          }
        }

        try {
          firebase.firestore().settings({
            cacheSizeBytes: firebase.firestore.CACHE_SIZE_UNLIMITED
          });
        } catch (sErr) {
          // ignore if settings already applied
        }

        this.firestore = firebase.firestore();
        console.log('Successfully connected to Firebase Firestore سحابي!');
        resolve(true);
      } catch (err) {
        console.error('Failed to initialize Firebase:', err);
        resolve(false);
      }
    });
  }

  /**
   * Helper function to race a network promise against a timeout.
   * NOTE: default raised from 1500ms to 30000ms because the sales_history
   * collection grows over time and full-collection server reads can take
   * several seconds; a 1.5s cap made large reads time out and return "no data".
   */
  _withTimeout(promise, ms = 30000) {
    let timer;
    const timeout = new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error('Network timeout')), ms);
    });
    return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
  }

  /**
   * Seeds the database if empty.
   * Seeds cloud Firestore on first connect.
   */
  async seedIfEmpty() {
    const initialData = {
      tables: [
        { id: 'table-1', number: '1', capacity: 2, status: 'available' },
        { id: 'table-2', number: '2', capacity: 4, status: 'available' },
        { id: 'table-3', number: '3', capacity: 4, status: 'available' },
        { id: 'table-4', number: '4', capacity: 6, status: 'available' },
        { id: 'table-5', number: '5', capacity: 2, status: 'available' },
        { id: 'table-6', number: '6', capacity: 8, status: 'available' },
        { id: 'table-7', number: '7', capacity: 4, status: 'available' },
        { id: 'table-8', number: '8', capacity: 6, status: 'available' }
      ],
      categories: [
        { id: 'cat-1', name: 'الشوربات والمقبلات', sortOrder: 0 },
        { id: 'cat-2', name: 'الأطباق الرئيسية', sortOrder: 1 },
        { id: 'cat-3', name: 'الحلويات', sortOrder: 2 },
        { id: 'cat-4', name: 'المشروبات الباردة', sortOrder: 3 },
        { id: 'cat-5', name: 'المشروبات الساخنة', sortOrder: 4 }
      ],
      products: [
        { id: 'prod-1', name: 'شوربة الفطر البري بالكريمة', price: 25000, categoryId: 'cat-1', color: '#d4af37' },
        { id: 'prod-2', name: 'سلطة السيزر بالدجاج المشوي', price: 32000, categoryId: 'cat-1', color: '#2ecc71' },
        { id: 'prod-3', name: 'بطاطا حارة مقرمشة بالأعشاب', price: 18000, categoryId: 'cat-1', color: '#e67e22' },
        { id: 'prod-4', name: 'ستيك ريب آي مع سوس الفلفل الأسود', price: 95000, categoryId: 'cat-2', color: '#c0392b' },
        { id: 'prod-5', name: 'سلمون مشوي بصلصة الليمون والشبت', price: 85000, categoryId: 'cat-2', color: '#16a085' },
        { id: 'prod-6', name: 'باستا الفريدو بالدجاج والفطر', price: 45000, categoryId: 'cat-2', color: '#f1c40f' },
        { id: 'prod-7', name: 'برجر لحم فاجر بخبز البريوش والجبن', price: 38000, categoryId: 'cat-2', color: '#d35400' },
        { id: 'prod-8', name: 'كعكة الشوكولاتة الذائبة (لافا كيك)', price: 28000, categoryId: 'cat-3', color: '#8e44ad' },
        { id: 'prod-9', name: 'تشيز كيك الفراولة النيويوركي', price: 26000, categoryId: 'cat-3', color: '#e84393' },
        { id: 'prod-10', name: 'تيراميسو إيطالي كلاسيكي', price: 24000, categoryId: 'cat-3', color: '#7f8c8d' },
        { id: 'prod-11', name: 'عصير برتقال طبيعي طازج', price: 15000, categoryId: 'cat-4', color: '#f39c12' },
        { id: 'prod-12', name: 'موخيتو الفراولة والنعناع المنعش', price: 18000, categoryId: 'cat-4', color: '#e84393' },
        { id: 'prod-13', name: 'مياه معدنية فوارة مستوردة', price: 8000, categoryId: 'cat-4', color: '#3498db' },
        { id: 'prod-14', name: 'قهوة إسبريسو مزدوجة', price: 12000, categoryId: 'cat-5', color: '#6d4c41' },
        { id: 'prod-15', name: 'كابتشينو برغوة مخملية', price: 16000, categoryId: 'cat-5', color: '#8d6e63' },
        { id: 'prod-16', name: 'شاي أخضر بالياسمين العضوي', price: 10000, categoryId: 'cat-5', color: '#a1887f' }
      ]
    };

    if (this.firestore) {
      try {
        const catSnapshot = await this._withTimeout(this.firestore.collection('categories').limit(1).get(), 10000);
        if (catSnapshot.empty) {
          console.log('Cloud Firestore is empty! Seeding default menu data...');
          const batch = this.firestore.batch();
          initialData.tables.forEach(tbl => {
            batch.set(this.firestore.collection('tables').doc(tbl.id), tbl);
          });
          initialData.categories.forEach(cat => {
            batch.set(this.firestore.collection('categories').doc(cat.id), cat);
          });
          initialData.products.forEach(prod => {
            batch.set(this.firestore.collection('products').doc(prod.id), prod);
          });
          await batch.commit();
          console.log('Cloud Firestore database successfully seeded!');
        }
        return true;
      } catch (err) {
        console.warn('Skipping seed check due to offline/timeout status:', err.message || err);
        return true;
      }
    }
    return false;
  }

  // --- GENERIC HELPER CRUD METHODS ---

  getAll(storeName, forceServer = false) {
    return new Promise(async (resolve) => {
      if (!this.firestore) {
        resolve([]);
        return;
      }

      // If forceServer is not explicitly requested, try local cache first for 0ms latency
      if (!forceServer) {
        try {
          const snapshot = await this.firestore.collection(storeName).get({ source: 'cache' });
          const data = [];
          snapshot.forEach(doc => {
            data.push({ id: doc.id, ...doc.data() });
          });

          // Only resolve cache immediately if it contains records. If empty, fall through to server/seed
          if (data.length > 0) {
            resolve(data);
            // Silently trigger background fetch from server to refresh cache
            this.firestore.collection(storeName).get({ source: 'server' }).catch(() => {});
            return;
          }
        } catch (cacheError) {
          // Cache empty or unavailable, proceed to protected server fetch
        }
      }

      try {
        const snapshot = await this._withTimeout(this.firestore.collection(storeName).get({ source: 'server' }), 30000);
        const data = [];
        snapshot.forEach(doc => {
          data.push({ id: doc.id, ...doc.data() });
        });
        resolve(data);
      } catch (error) {
        console.warn(`Firebase store ${storeName} server load timed out or offline, returning cache fallback:`, error.message || error);
        // Fallback: serve whatever the local cache holds so the UI never shows false "empty"
        try {
          const snapshot = await this.firestore.collection(storeName).get({ source: 'cache' });
          const data = [];
          snapshot.forEach(doc => {
            data.push({ id: doc.id, ...doc.data() });
          });
          resolve(data);
        } catch (cacheError) {
          resolve([]);
        }
      }
    });
  }

  get(storeName, key) {
    return new Promise(async (resolve) => {
      if (!this.firestore) {
        resolve(null);
        return;
      }
      try {
        // Try reading from cache first for instant retrieval
        const doc = await this.firestore.collection(storeName).doc(String(key)).get({ source: 'cache' });
        if (doc.exists) {
          resolve({ id: doc.id, ...doc.data() });
          
          // Silently trigger background fetch from server to update cache
          this.firestore.collection(storeName).doc(String(key)).get({ source: 'server' }).catch(() => {});
          return;
        }
      } catch (cacheError) {
        // Cache is empty or failed, proceed to server fetch
      }

      try {
        const doc = await this._withTimeout(this.firestore.collection(storeName).doc(String(key)).get(), 30000);
        if (doc && doc.exists) {
          resolve({ id: doc.id, ...doc.data() });
        } else {
          resolve(null);
        }
      } catch (error) {
        console.warn(`Firebase key ${key} load timed out or offline:`, error.message || error);
        resolve(null);
      }
    });
  }

  put(storeName, value) {
    return new Promise(async (resolve, reject) => {
      if (!this.firestore) {
        reject(new Error('Firebase Firestore not initialized'));
        return;
      }
      try {
        const record = JSON.parse(JSON.stringify(value));

        // Generate missing IDs
        if (storeName === 'categories' && !record.id) {
          record.id = 'cat-' + Date.now();
        } else if (storeName === 'products' && !record.id) {
          record.id = 'prod-' + Date.now();
        } else if (storeName === 'tables' && !record.id) {
          record.id = 'table-' + Date.now();
        } else if (storeName === 'printers' && !record.id) {
          record.id = 'printer-' + Date.now();
        } else if (storeName === 'sales_history' && !record.id) {
          record.id = String(Date.now());
        }

        const docId = String(storeName === 'active_orders' ? record.tableId : record.id);
        await this.firestore.collection(storeName).doc(docId).set(record);

        if (storeName === 'active_orders') {
          resolve(record.tableId);
        } else {
          resolve(record.id);
        }
      } catch (error) {
        console.error(`Firebase error saving to store ${storeName}:`, error);
        reject(error);
      }
    });
  }

  delete(storeName, key) {
    return new Promise(async (resolve) => {
      if (!this.firestore) {
        resolve(false);
        return;
      }
      try {
        await this.firestore.collection(storeName).doc(String(key)).delete();
        resolve(true);
      } catch (error) {
        console.error(`Firebase error deleting from store ${storeName}:`, error);
        resolve(false);
      }
    });
  }

  clearStore(storeName) {
    return new Promise(async (resolve) => {
      if (!this.firestore) {
        resolve(false);
        return;
      }
      try {
        const snapshot = await this.firestore.collection(storeName).get();
        const batch = this.firestore.batch();
        snapshot.forEach(doc => {
          batch.delete(doc.ref);
        });
        await batch.commit();
        resolve(true);
      } catch (error) {
        console.error(`Firebase error clearing store ${storeName}:`, error);
        resolve(false);
      }
    });
  }

  // --- SPECIFIC DOMAIN METHODS ---

  // 1. Categories CRUD
  async getCategories() {
    const res = await this.getAll('categories');
    if (!res || res.length === 0) {
      return [
        { id: 'cat-1', name: 'الشوربات والمقبلات', sortOrder: 0 },
        { id: 'cat-2', name: 'الأطباق الرئيسية', sortOrder: 1 },
        { id: 'cat-3', name: 'الحلويات', sortOrder: 2 },
        { id: 'cat-4', name: 'المشروبات الباردة', sortOrder: 3 },
        { id: 'cat-5', name: 'المشروبات الساخنة', sortOrder: 4 }
      ];
    }
    return res;
  }

  async saveCategory(category) {
    if (!category.id) {
      category.id = 'cat-' + Date.now();
    }
    return this.put('categories', category);
  }

  async deleteCategory(id) {
    const products = await this.getProducts();
    for (const prod of products) {
      if (prod.categoryId === id) {
        await this.deleteProduct(prod.id);
      }
    }
    return this.delete('categories', id);
  }

  // 2. Products CRUD
  async getProducts() {
    const res = await this.getAll('products');
    if (!res || res.length === 0) {
      return [
        { id: 'prod-1', name: 'شوربة الفطر البري بالكريمة', price: 25000, categoryId: 'cat-1', color: '#d4af37' },
        { id: 'prod-2', name: 'سلطة السيزر بالدجاج المشوي', price: 32000, categoryId: 'cat-1', color: '#2ecc71' },
        { id: 'prod-3', name: 'بطاطا حارة مقرمشة بالأعشاب', price: 18000, categoryId: 'cat-1', color: '#e67e22' },
        { id: 'prod-4', name: 'ستيك ريب آي مع سوس الفلفل الأسود', price: 95000, categoryId: 'cat-2', color: '#c0392b' },
        { id: 'prod-5', name: 'سلمون مشوي بصلصة الليمون والشبت', price: 85000, categoryId: 'cat-2', color: '#16a085' },
        { id: 'prod-6', name: 'باستا الفريدو بالدجاج والفطر', price: 45000, categoryId: 'cat-2', color: '#f1c40f' },
        { id: 'prod-7', name: 'برجر لحم فاجر بخبز البريوش والجبن', price: 38000, categoryId: 'cat-2', color: '#d35400' },
        { id: 'prod-8', name: 'كعكة الشوكولاتة الذائبة (لافا كيك)', price: 28000, categoryId: 'cat-3', color: '#8e44ad' },
        { id: 'prod-9', name: 'تشيز كيك الفراولة النيويوركي', price: 26000, categoryId: 'cat-3', color: '#e84393' },
        { id: 'prod-10', name: 'تيراميسو إيطالي كلاسيكي', price: 24000, categoryId: 'cat-3', color: '#7f8c8d' },
        { id: 'prod-11', name: 'عصير برتقال طبيعي طازج', price: 15000, categoryId: 'cat-4', color: '#f39c12' },
        { id: 'prod-12', name: 'موخيتو الفراولة والنعناع المنعش', price: 18000, categoryId: 'cat-4', color: '#e84393' },
        { id: 'prod-13', name: 'مياه معدنية فوارة مستوردة', price: 8000, categoryId: 'cat-4', color: '#3498db' },
        { id: 'prod-14', name: 'قهوة إسبريسو مزدوجة', price: 12000, categoryId: 'cat-5', color: '#6d4c41' },
        { id: 'prod-15', name: 'كابتشينو برغوة مخملية', price: 16000, categoryId: 'cat-5', color: '#8d6e63' },
        { id: 'prod-16', name: 'شاي أخضر بالياسمين العضوي', price: 10000, categoryId: 'cat-5', color: '#a1887f' }
      ];
    }
    return res;
  }

  async saveProduct(product) {
    if (!product.id) {
      product.id = 'prod-' + Date.now();
    }
    product.price = parseFloat(product.price) || 0;
    return this.put('products', product);
  }

  async deleteProduct(id) {
    return this.delete('products', id);
  }

  // 3. Tables CRUD
  async getTables() {
    const res = await this.getAll('tables');
    if (!res || res.length === 0) {
      return [
        { id: 'table-1', number: '1', capacity: 2, status: 'available' },
        { id: 'table-2', number: '2', capacity: 4, status: 'available' },
        { id: 'table-3', number: '3', capacity: 4, status: 'available' },
        { id: 'table-4', number: '4', capacity: 6, status: 'available' },
        { id: 'table-5', number: '5', capacity: 2, status: 'available' },
        { id: 'table-6', number: '6', capacity: 8, status: 'available' },
        { id: 'table-7', number: '7', capacity: 4, status: 'available' },
        { id: 'table-8', number: '8', capacity: 6, status: 'available' }
      ];
    }
    return res;
  }

  async saveTable(table) {
    if (!table.id) {
      table.id = 'table-' + Date.now();
    }
    table.capacity = parseInt(table.capacity) || 2;
    if (!table.status) table.status = 'available';
    return this.put('tables', table);
  }

  async deleteTable(id) {
    await this.delete('active_orders', id);
    return this.delete('tables', id);
  }

  async updateTableStatus(id, status) {
    // Use Firestore update() to patch only the status field directly,
    // eliminating the costly read-then-write round-trip.
    if (!this.firestore) return null;
    try {
      await this.firestore.collection('tables').doc(String(id)).update({ status });
      return true;
    } catch (error) {
      console.error(`Firebase error updating table status for ${id}:`, error);
      return null;
    }
  }

  // 4. Active Orders CRUD
  async getActiveOrder(tableId) {
    return this.get('active_orders', tableId);
  }

  async saveActiveOrder(tableId, orderData) {
    orderData.tableId = tableId;
    orderData.lastUpdated = Date.now();
    return this.put('active_orders', orderData);
  }

  async clearActiveOrder(tableId) {
    return this.delete('active_orders', tableId);
  }

  // 5. Sales History CRUD (Offline Cache + Smart Incremental Cloud Sync)
  async getSalesHistory(forceServer = false) {
    if (!this.firestore) return [];

    // 1. Fetch all sales stored locally in Firestore IndexedDB cache
    let cachedSales = [];
    try {
      const snapshot = await this.firestore.collection('sales_history').get({ source: 'cache' });
      snapshot.forEach(doc => { cachedSales.push({ id: doc.id, ...doc.data() }); });
    } catch (e) {
      console.warn('Failed reading sales from offline cache:', e);
    }

    // 2. Perform incremental sync if cached sales exist and forceServer is false
    if (cachedSales.length > 0 && !forceServer) {
      let maxTimestamp = 0;
      cachedSales.forEach(s => {
        const t = s.timestamp || s.endTime || 0;
        if (t > maxTimestamp) maxTimestamp = t;
      });

      if (maxTimestamp > 0) {
        try {
          // Query ONLY new sales added to cloud after maxTimestamp
          const newSnapshot = await this._withTimeout(
            this.firestore.collection('sales_history')
              .where('timestamp', '>', maxTimestamp)
              .get({ source: 'server' }),
            10000
          );

          if (!newSnapshot.empty) {
            const salesMap = new Map();
            cachedSales.forEach(s => salesMap.set(String(s.id), s));
            newSnapshot.forEach(doc => {
              salesMap.set(String(doc.id), { id: doc.id, ...doc.data() });
            });
            cachedSales = Array.from(salesMap.values());
            console.log(`Incremental sales sync: fetched ${newSnapshot.size} new records from cloud.`);
          }
        } catch (err) {
          console.warn('Incremental sales cloud sync note (using offline cache):', err.message || err);
        }

        return cachedSales;
      }
    }

    // 3. If local cache is empty or forceServer=true, perform initial load from server
    return this._getAllPaginated('sales_history');
  }

  /**
   * Reads a whole Firestore collection from the server using cursor pagination
   * (orderBy __name__ + startAfter), so arbitrarily large collections load
   * completely and reliably. Falls back to the local cache if offline.
   */
  async _getAllPaginated(storeName, pageSize = 500) {
    const all = [];
    try {
      let lastDoc = null;
      for (;;) {
        let q = this.firestore.collection(storeName).orderBy('__name__').limit(pageSize);
        if (lastDoc) q = q.startAfter(lastDoc);

        const snapshot = await this._withTimeout(q.get({ source: 'server' }), 60000);
        const page = [];
        snapshot.forEach(doc => { page.push({ id: doc.id, ...doc.data() }); });
        all.push(...page);

        if (snapshot.empty || page.length < pageSize) break;
        lastDoc = snapshot.docs[snapshot.docs.length - 1];
      }
      return all;
    } catch (error) {
      console.warn(`Firebase store ${storeName} paginated server load failed, returning cache fallback:`, error.message || error);
      try {
        const snapshot = await this.firestore.collection(storeName).get({ source: 'cache' });
        const data = [];
        snapshot.forEach(doc => { data.push({ id: doc.id, ...doc.data() }); });
        return data;
      } catch (cacheError) {
        return [];
      }
    }
  }

  async addSale(saleData) {
    saleData.timestamp = Date.now();
    return this.put('sales_history', saleData);
  }

  async clearSalesHistory() {
    return this.clearStore('sales_history');
  }

  // 6. Reservations CRUD
  async getReservations() {
    return this.getAll('reservations');
  }

  async saveReservation(reservation) {
    if (!reservation.id) {
      reservation.id = 'res-' + Date.now();
    }
    return this.put('reservations', reservation);
  }

  async deleteReservation(id) {
    return this.delete('reservations', id);
  }

  // 7. Printers CRUD
  async getPrinters() {
    return this.getAll('printers');
  }

  async savePrinter(printer) {
    if (!printer.id) {
      printer.id = 'printer-' + Date.now();
    }
    return this.put('printers', printer);
  }

  async deletePrinter(id) {
    return this.delete('printers', id);
  }
}

// Export database class globally so it can be instantiated in app.js
window.BistroDatabase = BistroDatabase;
