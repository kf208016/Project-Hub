/* Mobile project navigation: retain the native desktop navigation landmark. */
(() => {
  'use strict';
  const media = matchMedia('(max-width:900px)');
  const list = document.querySelector('#list'), toggle = document.querySelector('#menu-toggle');
  const previousInert = new Map();
  let opened = false;
  function close(restoreFocus = true) {
    const wasOpen = opened;
    opened = false;
    document.body.classList.remove('show-list');
    toggle.setAttribute('aria-expanded', 'false');
    list.inert = media.matches;
    for (const [element, value] of previousInert) element.inert = value;
    previousInert.clear();
    if (wasOpen && restoreFocus && media.matches) toggle.focus();
  }
  function open() {
    if (!media.matches || opened) return;
    opened = true;
    list.inert = false;
    document.body.classList.add('show-list');
    toggle.setAttribute('aria-expanded', 'true');
    for (const element of document.querySelectorAll('#main, .mobile-information, .bar > :not(#menu-toggle)')) {
      previousInert.set(element, element.inert);
      element.inert = true;
    }
    (list.querySelector('button:not(:disabled), a[href], input:not(:disabled)') || toggle).focus();
  }
  document.addEventListener('keydown', event => {
    if (!opened) return;
    if (event.key === 'Escape') { event.preventDefault(); close(); return; }
    if (event.key !== 'Tab') return;
    const stops = [toggle, ...list.querySelectorAll('button:not(:disabled), a[href], input:not(:disabled), select:not(:disabled), [tabindex="0"]')]
      .filter(element => !element.closest('[hidden], [inert]') && element.getClientRects().length);
    const index = stops.indexOf(document.activeElement);
    if (index < 0 || event.shiftKey && index === 0 || !event.shiftKey && index === stops.length - 1) {
      event.preventDefault();
      (event.shiftKey ? stops.at(-1) : stops[0])?.focus();
    }
  });
  media.addEventListener('change', () => close(false));
  close(false);
  window.HubNavigation = {close, toggle: () => opened ? close() : open()};
})();
