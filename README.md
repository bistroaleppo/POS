# 🍽️ Bistro POS - Comprehensive Restaurant Management System

[![Version](https://img.shields.io/badge/version-1.0.4-193B23.svg?style=flat-square)](package.json)
[![Platform](https://img.shields.io/badge/platform-Electron%20%7C%20Web%20%7C%20PWA-193B23.svg?style=flat-square)](package.json)
[![Database](https://img.shields.io/badge/database-Firebase%20Firestore%20(Offline%20First)-orange.svg?style=flat-square)](database.js)
[![License](https://img.shields.io/badge/license-DotTech-blue.svg?style=flat-square)](package.json)

**Bistro POS** is a modern, high-performance, offline-first Point of Sale (POS) and restaurant management application built by **DotTech (Salem Makoukji)**. It combines the power of a desktop application (via Electron) with cloud synchronization (via Firebase Firestore) and a pure client-side offline engine using IndexedDB persistence.

Designed specifically with a sleek Arabic Right-to-Left (RTL) user interface, Bistro POS provides end-to-end management for restaurant tables, order processing, kitchen ticket routing, hybrid thermal printing, financial analytics, and customer digital menus.

---

## 📋 Table of Contents

- [Key Features](#-key-features)
- [Technology Stack](#-technology-stack)
- [Architecture & Printing Engine](#-architecture--printing-engine)
- [Project Directory Structure](#-project-directory-structure)
- [Getting Started](#-getting-started)
  - [Prerequisites](#prerequisites)
  - [Installation](#installation)
  - [Firebase Configuration](#firebase-configuration)
- [Running the Application](#-running-the-application)
- [Printing System Setup](#-printing-system-setup)
- [Financial & Analytics Dashboard](#-financial--analytics-dashboard)
- [Building Desktop Executable](#-building-desktop-executable)
- [Author & License](#-author--license)

---

## 🌟 Key Features

### 🏢 1. Floor & Table Management
- **Interactive Floor Plan**: Visual real-time grid of dining tables.
- **Dynamic Status Indicators**: Real-time status badges for `Available` (متاح), `Occupied` (مشغول), and `Reserved` (محجوز).
- **Slide-Over Quick Order Panel**: Swiftly manage open orders, add items, adjust quantities, add special instructions/notes, and track dining duration.
- **Table Transfer**: Seamlessly move active orders between tables.

### 🍕 2. Order & Cart Management
- **Category & Product Catalog**: Organized food/beverage menu with custom color-coded item cards and pricing in Syrian Lira (`ل.س`).
- **Quick Search & Filtering**: Fast filtering by categories for high-speed checkout during peak hours.
- **Order Extras & Customization**: Support for item notes, discounts, tax calculations, and table service details.
- **Receipt & Kitchen Order Ticket (KOT)**: Auto-generates itemized customer receipts and kitchen tickets.

### 🖨️ 3. Hardware Thermal Printing Engine
- **Direct USB Raw Driver Bypass**: Native C#/PowerShell kernel32 bridge (`CreateFile`/`WriteFile`) that writes ESC/POS bytes directly to USB thermal printers—bypassing buggy Windows spoolers and vendor drivers.
- **Network / LAN Thermal Printing**: Direct raw TCP socket printing to network printers on Port 9100.
- **Silent Windows Driver Printing**: Native silent HTML thermal printing with dynamic paper height measurement for 80mm (72mm printable width) receipt paper rolls.
- **Standalone HTTP Print Server**: Included `print-server.js` Node.js service for routing ESC/POS jobs from web browsers to LAN printers.

### 📊 4. Financial & Analytics Dashboard (`finance.html`)
- **Revenue & Profit Metrics**: Track total sales, daily/monthly revenue, net profit, average ticket size, and expenses.
- **Visual Chart Reports**: Interactive financial charts for sales trends, top-selling categories, and peak sales hours.
- **Expense Logging**: Record operational expenses with category tagging and date filtering.
- **Financial Statement Exports**: Generate printable and exportable financial summaries.

### 📱 5. Customer Digital Menu (`menu.html`)
- **Responsive Mobile Web Page**: Clean, modern digital menu interface designed for customer smartphones or tablet display tables.
- **Categorized View**: Beautiful Arabic typography (Cairo & Playfair Display fonts) displaying products, prices, and descriptions.

### 🔐 6. Offline-First & Enterprise Security
- **Firebase Firestore Sync**: Real-time cloud database synchronization.
- **IndexedDB Local Cache**: 100% functional offline mode—cashiers can continue taking orders even without internet connectivity; changes auto-sync when online.
- **Role-Based Login**: Firebase Authentication gate protecting cashier management actions.

---

## 🛠️ Technology Stack

| Layer | Technology |
| :--- | :--- |
| **Desktop Shell** | [Electron v43+](https://www.electronjs.org/) with `contextBridge` isolation |
| **Packaging** | [electron-builder v26+](https://www.electron.build/) (NSIS Installer) |
| **Frontend UI** | HTML5 (RTL Arabic), CSS3 (CSS Variables, Flexbox/Grid), Vanilla JavaScript (ES6+) |
| **Typography** | Google Fonts ([Cairo](https://fonts.google.com/specimen/Cairo), [Inter](https://fonts.google.com/specimen/Inter), [Playfair Display](https://fonts.google.com/specimen/Playfair+Display)) |
| **Database & Auth** | [Firebase Firestore (v8 SDK)](https://firebase.google.com/) + Firebase Authentication |
| **Local Persistence** | Browser/Electron IndexedDB offline persistence |
| **Hardware Access** | Node.js `net` module, Windows PowerShell P/Invoke `kernel32.dll`, [`electron-pos-printer`](https://www.npmjs.com/package/electron-pos-printer) |
| **Print Bridge Server** | Node.js HTTP Server (`print-server.js`) |

---

## 🏗️ Architecture & Printing Engine

```
                               ┌──────────────────────────────────────────┐
                               │             Bistro POS App               │
                               │  (Electron Desktop Shell / Web / PWA)    │
                               └────────────────────┬─────────────────────┘
                                                    │
                 ┌──────────────────────────────────┼──────────────────────────────────┐
                 │                                  │                                  │
                 ▼                                  ▼                                  ▼
     ┌──────────────────────┐           ┌──────────────────────┐           ┌──────────────────────┐
     │  Firebase Firestore  │           │   Electron Main Process│          │  Standalone Print    │
     │  + IndexedDB Cache   │           │    (IPC Printing)    │           │    Server (Port 6333)│
     └──────────────────────┘           └───────────┬──────────┘           └───────────┬──────────┘
                                                    │                                  │
                               ┌────────────────────┴───────────────────┐              │
                               │                                        │              │
                               ▼                                        ▼              ▼
                   ┌───────────────────────┐                ┌───────────────────────┐
                   │ Direct USB Raw Write  │                │  TCP Network Socket   │
                   │ (kernel32.dll PS1)    │                │      (Port 9100)      │
                   └───────────┬───────────┘                └───────────┬───────────┘
                               │                                        │
                               ▼                                        ▼
                   ┌───────────────────────┐                ┌───────────────────────┐
                   │  USB Thermal Printer  │                │ LAN / WiFi Printer    │
                   │    (e.g., POS-80)     │                │   (Kitchen / Cashier) │
                   └───────────────────────┘                └───────────────────────┘
```

---

## 📁 Project Directory Structure

```
Bistro/
├── assets/                  # Brand logos, icons, and static image assets
├── electron/
│   ├── main.js              # Electron main process & native IPC print handlers
│   └── preload.js           # Secure contextBridge IPC exposure to renderer
├── app.js                   # Primary POS client logic, UI state & event handlers
├── database.js              # Firebase Firestore driver & IndexedDB offline configuration
├── print-server.js          # Standalone HTTP printer bridge server (Port 6333)
├── index.html               # Main POS Cashier & Table Management Interface
├── finance.html             # Financial Dashboard & Accounting Analytics Interface
├── menu.html                # Customer-facing Digital Food Menu web page
├── style.css                # Custom CSS Design System (RTL layout, dark green accents)
├── manifest.json            # Web App Manifest for PWA installation
├── service-worker.js        # Service Worker for PWA caching & offline asset serving
├── package.json             # NPM project metadata, dependencies & scripts
└── package-lock.json        # Locked dependency versions
```

---

## 🚀 Getting Started

### Prerequisites

- **Node.js**: `v18.0.0` or higher
- **NPM**: `v9.0.0` or higher
- **OS**: Windows 10/11 (for full native USB raw thermal printer features and Windows packaging)

### Installation

1. **Clone or Open the Repository**:
   ```bash
   cd d:/Codes/Bistro
   ```

2. **Install Dependencies**:
   ```bash
   npm install
   ```

### Firebase Configuration

The database driver in [`database.js`](file:///d:/Codes/Bistro/database.js) connects to Firebase Firestore.

Ensure your Firebase credentials in [`database.js`](file:///d:/Codes/Bistro/database.js) match your project:

```javascript
const firebaseConfig = {
  apiKey: "YOUR_API_KEY",
  authDomain: "your-app.firebaseapp.com",
  projectId: "your-app-id",
  storageBucket: "your-app.firebasestorage.app",
  messagingSenderId: "YOUR_SENDER_ID",
  appId: "YOUR_APP_ID"
};
```

---

## 💻 Running the Application

### Option A: Desktop Application (Electron)

To launch the desktop version with full native access:

```bash
npm start
```

### Option B: Web Browser / Local HTTP Server

You can serve the directory using any static web server (e.g., `live-server` or `http-server`):

```bash
npx http-server -p 8080
```
Then open `http://localhost:8080/index.html` in your browser.

---

## 🖨️ Printing System Setup

Bistro POS supports three print routing modes:

### 1. Direct USB Printing (Windows Desktop)
- Bypasses the Windows Spooler and raw vendor drivers to communicate directly with thermal receipt printers (e.g., POS-80).
- Handled automatically by native PowerShell script invoking Windows kernel API functions (`CreateFile`, `WriteFile`).

### 2. Network / WiFi IP Printing
- Connect thermal printers over your local network.
- Configurable IP & Port (default `9100`) directly from **Settings -> Printer Management** inside the POS.

### 3. Standalone Print Server (`print-server.js`)
If running Bistro POS in a web browser (non-Electron), launch the print server to handle background ESC/POS network printing:

```bash
node print-server.js
```
*Optional environment flags:*
```bash
PORT=6333 PRINT_SERVER_TOKEN=secret node print-server.js
```

---

## 📊 Financial & Analytics Dashboard

Access `finance.html` directly or navigate via the POS interface to view:
- Daily, Weekly, and Monthly Revenue breakdown.
- Expense tracking and net profit statements.
- Interactive charts detailing category sales distribution.
- Shift cash drawer reconciliation.

---

## 📦 Building Desktop Executable

To build the standalone Windows installer (`.exe` NSIS installer):

```bash
# Package as Windows installer
npm run dist

# Or package into an unpacked directory for fast testing
npm run dist:dir
```

Output binaries will be generated in the `dist/` directory.

---

## 👤 Author & License

Developed and Maintained by:
- **Author**: DotTech - Salem Makoukji
- **License**: DotTech Proprietary / All Rights Reserved

---
*For support or custom feature integration, contact DotTech.*
