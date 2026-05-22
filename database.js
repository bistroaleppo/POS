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
        const catSnapshot = await this.firestore.collection('categories').limit(1).get();
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
        console.error('Error seeding Firestore database:', err);
        return false;
      }
    }
    return false;
  }

  // --- GENERIC HELPER CRUD METHODS ---

  getAll(storeName) {
    return new Promise(async (resolve) => {
      if (!this.firestore) {
        resolve([]);
        return;
      }
      try {
        const snapshot = await this.firestore.collection(storeName).get();
        const data = [];
        snapshot.forEach(doc => {
          data.push({ id: doc.id, ...doc.data() });
        });
        resolve(data);
      } catch (error) {
        console.error(`Firebase error loading store ${storeName}:`, error);
        resolve([]);
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
        const doc = await this.firestore.collection(storeName).doc(String(key)).get();
        if (doc.exists) {
          resolve({ id: doc.id, ...doc.data() });
        } else {
          resolve(null);
        }
      } catch (error) {
        console.error(`Firebase error loading key ${key} from store ${storeName}:`, error);
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
    return this.getAll('categories');
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
    return this.getAll('products');
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
    return this.getAll('tables');
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
    const table = await this.get('tables', id);
    if (table) {
      table.status = status;
      return this.put('tables', table);
    }
    return null;
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

  // 5. Sales History CRUD
  async getSalesHistory() {
    return this.getAll('sales_history');
  }

  async addSale(saleData) {
    saleData.timestamp = Date.now();
    return this.put('sales_history', saleData);
  }

  async clearSalesHistory() {
    return this.clearStore('sales_history');
  }
}

// Export database class globally so it can be instantiated in app.js
window.BistroDatabase = BistroDatabase;
