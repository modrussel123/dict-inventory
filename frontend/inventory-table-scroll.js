(function () {
  let refresh = () => {};
  let frame = 0;
  function schedule() {
    if (frame) return;
    frame = requestAnimationFrame(() => {
      frame = 0;
      refresh();
    });
  }
  window.InventoryTableScroll = { update: schedule };

  function init() {
    const table = document.getElementById('inventoryTable');
    const viewport = table?.parentElement;
    const heading = table?.querySelector('thead tr');
    if (!table || !viewport || !heading) return;

    const controls = document.createElement('div');
    controls.className = 'inventory-scroll-controls no-print';
    controls.hidden = true;
    controls.innerHTML = '<div class="inventory-scroll-label">Scroll left or right to view all columns</div>' +
      '<div class="inventory-top-scrollbar" tabindex="0" role="region" aria-label="Scroll inventory columns left or right">' +
      '<div class="inventory-scroll-spacer"></div></div>';
    viewport.before(controls);
    viewport.classList.add('inventory-table-viewport');
    const scrollbar = controls.querySelector('.inventory-top-scrollbar');
    const spacer = controls.querySelector('.inventory-scroll-spacer');

    scrollbar.addEventListener('scroll', () => {
      if (Math.abs(viewport.scrollLeft - scrollbar.scrollLeft) > 0.5) {
        viewport.scrollLeft = scrollbar.scrollLeft;
      }
    }, { passive: true });
    viewport.addEventListener('scroll', () => {
      if (Math.abs(scrollbar.scrollLeft - viewport.scrollLeft) > 0.5) {
        scrollbar.scrollLeft = viewport.scrollLeft;
      }
    }, { passive: true });

    refresh = () => {
      const overflow = table.getClientRects().length > 0 && viewport.scrollWidth > viewport.clientWidth + 1;
      controls.hidden = !overflow;
      spacer.style.width = viewport.scrollWidth + 'px';
      scrollbar.scrollLeft = viewport.scrollLeft;

      // Both the bar and headings stay together below the page's fixed header
      // and, on the dashboard, the sticky statistics/filter panel.
      const zoom = parseFloat(getComputedStyle(document.body).zoom) || 1;
      const header = document.querySelector('header');
      const stickyPanel = document.getElementById('stickyTopBar');
      const anchor = Math.max(0, header?.getBoundingClientRect().bottom || 0,
        stickyPanel?.getBoundingClientRect().bottom || 0) / zoom;
      const barHeight = overflow ? controls.offsetHeight : 0;
      const tableRect = table.getBoundingClientRect();
      const maxShift = Math.max(0, (tableRect.height - heading.getBoundingClientRect().height) / zoom);
      const shift = Math.max(0, Math.min(anchor + barHeight - tableRect.top / zoom, maxShift));
      controls.style.transform = shift ? `translateY(${shift}px)` : '';
      heading.style.transform = shift ? `translateY(${shift}px)` : '';
    };

    if (window.ResizeObserver) {
      const observer = new ResizeObserver(schedule);
      [table, viewport, document.querySelector('header'), document.getElementById('stickyTopBar')]
        .filter(Boolean).forEach(element => observer.observe(element));
    }
    window.addEventListener('scroll', schedule, { passive: true });
    window.addEventListener('resize', schedule, { passive: true });
    window.addEventListener('afterprint', schedule);
    schedule();
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init, { once: true });
  else init();
})();
