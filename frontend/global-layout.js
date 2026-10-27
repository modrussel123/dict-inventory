/**
 * Global Layout & Navigation System
 * DICT-NBP Inventory & Management Suite
 * 
 * Provides unified, shared Header, Footer, and Navigation Sidebar across all pages.
 * The header and footer design and layout match the dashboard (index.html) exactly.
 * To add a new screen/panel to the hamburger menu in the future, simply add it to
 * the NAV_ITEMS array below.
 */

(function () {
  'use strict';

  // ── Navigation Configuration ───────────────────────────────────────────────
  const NAV_ITEMS = [
    {
      title: 'Dashboard',
      href: '/',
      aliases: ['/', '/index.html']
    },
    {
      title: 'Export Records',
      href: '/export-records.html',
      aliases: ['/export-records', '/export-records.html']
    },
    {
      title: 'Transaction Activity',
      href: '/transaction-activity.html',
      aliases: ['/transaction-activity', '/transaction-activity.html']
    }
  ];

  // ── Detect Active Navigation Item ───────────────────────────────────────────
  function getActiveIndex() {
    const path = window.location.pathname.toLowerCase();
    for (let i = 0; i < NAV_ITEMS.length; i++) {
      const item = NAV_ITEMS[i];
      if (item.aliases.some(alias => path === alias.toLowerCase() || (alias !== '/' && path.endsWith(alias.toLowerCase())))) {
        return i;
      }
    }
    for (let i = 0; i < NAV_ITEMS.length; i++) {
      const clean = NAV_ITEMS[i].href.replace('.html', '').replace('/', '');
      if (clean && path.includes(clean)) return i;
    }
    return 0; // Default to Dashboard
  }

  // ── Render Header HTML (Exact Dashboard Design) ─────────────────────────────
  function getHeaderHtml() {
    return `
      <div class="global-header-inner" style="width:100%; max-width:98%; margin:0 auto; padding:0.375rem 1rem; display:grid; grid-template-columns:1fr auto 1fr; align-items:center;">
        <!-- Left: Hamburger button matching dashboard margin -->
        <div style="display:flex; align-items:center; justify-content:flex-start;">
          <button id="navHamburger" onclick="openNavSidebar()" aria-label="Open navigation menu" class="no-print">
            <i class="fa-solid fa-bars"></i>
          </button>
        </div>

        <!-- Center: Republic of the Philippines / DICT Logo (strictly centered at 50%) -->
        <div style="display:flex; align-items:center; justify-content:center;">
          <a href="/" style="display:inline-flex; align-items:center; text-decoration:none;">
            <img src="logo/dict-center-logo.png" alt="DICT Logo"
              class="h-20 sm:h-20 max-sm:h-9 max-sm:max-w-40 w-auto object-contain"
              style="height:5rem; width:auto; object-fit:contain; display:block;">
          </a>
        </div>

        <!-- Right: NBP and Bagong Pilipinas logos matching dashboard margin -->
        <div style="display:flex; align-items:center; justify-content:flex-end; gap:16px;">
          <div style="display:flex; align-items:center; gap:6px;">
            <img src="logo/nbp-logo.png" alt="National Broadband Plan Logo"
              class="h-[4.5rem] max-sm:h-8 w-auto object-contain shrink-0"
              style="height:4.5rem; width:auto; object-fit:contain; flex-shrink:0;">
            <img src="logo/dict-nbp-text-no-bg.png" alt="National Broadband Plan"
              class="h-9 sm:h-10 max-sm:h-4 w-auto object-contain shrink-0"
              style="height:2.5rem; max-width:160px; width:auto; object-fit:contain; flex-shrink:0;">
          </div>
          <img src="logo/bagong-pilipinas-logo-no-bg.png" alt="Bagong Pilipinas Logo"
            class="h-[4.5rem] max-sm:h-9 w-auto object-contain shrink-0"
            style="height:4.5rem; width:auto; object-fit:contain; flex-shrink:0;">
        </div>
      </div>
    `;
  }

  // ── Render Sidebar HTML ─────────────────────────────────────────────────────
  function getSidebarHtml() {
    const activeIdx = getActiveIndex();
    const navLinksHtml = NAV_ITEMS.map((item, idx) => {
      const isActive = idx === activeIdx;
      if (isActive) {
        return `
          <a href="${item.href}" class="sidebar-nav-item active" aria-current="page">
            ${item.title}
            <span class="sidebar-nav-badge">Active</span>
          </a>
        `;
      }
      return `
        <a href="${item.href}" class="sidebar-nav-item">
          ${item.title}
        </a>
      `;
    }).join('');

    return `
      <!-- Nav Sidebar Overlay -->
      <div id="navSidebarOverlay" onclick="closeNavSidebar()"></div>

      <!-- Nav Sidebar Drawer -->
      <aside id="navSidebar" role="navigation" aria-label="Main navigation">
        <div class="sidebar-header">
          <img src="logo/dict-logo.png" alt="DICT Logo">
          <div>
            <div class="sidebar-title">DICT-NBP</div>
            <div class="sidebar-subtitle">Inventory System</div>
          </div>
          <button class="sidebar-close" onclick="closeNavSidebar()" aria-label="Close navigation">
            <i class="fa-solid fa-xmark"></i>
          </button>
        </div>

        <nav class="sidebar-nav-container">
          <div class="sidebar-section-label">Navigation</div>
          ${navLinksHtml}
        </nav>

        <div class="sidebar-footer">
          DICT Region 1 &mdash; Ilocos Norte Provincial Office
        </div>
      </aside>
    `;
  }

  // ── Render Footer HTML (Exact Dashboard Design) ─────────────────────────────
  function getFooterHtml() {
    return `
      <div class="flex flex-col items-center gap-5">
        <div class="inventory-footer-copyright flex w-full justify-center text-center text-xs text-slate-300">
          &copy; 2026 DICT Region 1 - Ilocos Norte Provincial Office. All rights reserved.
        </div>
        <div class="inventory-footer-logo-row flex w-full flex-wrap items-center justify-between gap-10">
          <div class="flex flex-wrap items-center gap-4">
            <img src="logo/dict-logo-with-text-no-background.png" alt="DICT"
              class="inventory-footer-logo inventory-footer-region">
            <img src="logo/DICT-REGION-1-no-bg.png" alt="DICT Region 1"
              class="inventory-footer-logo inventory-footer-region-secondary">
          </div>
          <div class="ml-auto flex flex-wrap items-center justify-end gap-x-5 gap-y-4 sm:gap-x-7">
            <img src="logo/nbp-logo.png" alt="National Broadband Program"
              class="inventory-footer-logo inventory-footer-nbp">
            <img src="logo/bagong-pilipinas-logo-no-bg.png" alt="Bagong Pilipinas"
              class="inventory-footer-logo inventory-footer-bagong">
          </div>
        </div>
      </div>
    `;
  }

  // ── Sidebar Open / Close Controls ───────────────────────────────────────────
  window.openNavSidebar = function () {
    const sidebar = document.getElementById('navSidebar');
    const overlay = document.getElementById('navSidebarOverlay');
    if (sidebar) sidebar.classList.add('open');
    if (overlay) overlay.classList.add('open');
    document.body.style.overflow = 'hidden';
  };

  window.closeNavSidebar = function () {
    const sidebar = document.getElementById('navSidebar');
    const overlay = document.getElementById('navSidebarOverlay');
    if (sidebar) sidebar.classList.remove('open');
    if (overlay) overlay.classList.remove('open');
    document.body.style.overflow = '';
  };

  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape') {
      window.closeNavSidebar();
    }
  });

  // ── Mount Layout Components ─────────────────────────────────────────────────
  function mountGlobalLayout() {
    // 1. Sidebar injection
    if (!document.getElementById('navSidebar') && document.body) {
      const sidebarContainer = document.createElement('div');
      sidebarContainer.id = 'globalSidebarMount';
      sidebarContainer.innerHTML = getSidebarHtml();
      document.body.insertBefore(sidebarContainer, document.body.firstChild);
    } else if (document.getElementById('navSidebar')) {
      // Update active nav class if sidebar already exists
      const activeIdx = getActiveIndex();
      const items = document.querySelectorAll('#navSidebar .sidebar-nav-item, #navSidebar .nav-item');
      items.forEach((el, idx) => {
        if (idx === activeIdx) {
          el.classList.add('active');
          if (!el.querySelector('.sidebar-nav-badge, .nav-badge')) {
            const badge = document.createElement('span');
            badge.className = 'sidebar-nav-badge';
            badge.textContent = 'Active';
            el.appendChild(badge);
          }
        } else {
          el.classList.remove('active');
          const badge = el.querySelector('.sidebar-nav-badge, .nav-badge');
          if (badge) badge.remove();
        }
      });
    }

    // 2. Header injection (if empty or placeholder)
    const headerEl = document.getElementById('globalHeader');
    if (headerEl && (!headerEl.innerHTML || !headerEl.innerHTML.trim())) {
      headerEl.className = 'global-header bg-white text-slate-800 shadow-sm border-b border-slate-200 no-print sticky top-0 z-30';
      headerEl.innerHTML = getHeaderHtml();
    }

    // 3. Footer injection (if empty or placeholder)
    const footerEl = document.getElementById('globalFooter');
    if (footerEl && (!footerEl.innerHTML || !footerEl.innerHTML.trim())) {
      footerEl.className = 'inventory-footer no-print relative w-full bg-slate-900 px-5 py-6 text-slate-100 shadow-lg mt-auto';
      footerEl.setAttribute('aria-label', 'DICT and National Broadband Program footer');
      footerEl.innerHTML = getFooterHtml();
    }
  }

  // Execute mounting
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', mountGlobalLayout);
  } else {
    mountGlobalLayout();
  }

  // Expose global helper
  window.GLOBAL_LAYOUT = {
    navItems: NAV_ITEMS,
    refresh: mountGlobalLayout,
    openSidebar: window.openNavSidebar,
    closeSidebar: window.closeNavSidebar
  };

})();
