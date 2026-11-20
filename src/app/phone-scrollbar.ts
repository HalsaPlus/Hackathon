import './phone-scrollbar.css';

// In Casper's /phone (public/phone.html) the patient app runs in an iframe
// with id "app". There the desktop scrollbar runs down behind the tab bar.
// When the app is inside that phone, it is marked so phone-scrollbar.css can
// give it a phone's slim scrollbar that stops above the tab bar. Anywhere
// else (a real phone, a browser window, the start page) nothing changes.

function insideThePhone() {
  try {
    const frame = window.frameElement;
    const parentPath = window.parent.location.pathname.replace(/\/+$/, '');
    return frame?.id === 'app' && (parentPath === '/phone' || parentPath === '/phone.html');
  } catch {
    return false; // Not the same origin: not our phone.
  }
}

if (typeof window !== 'undefined' && insideThePhone()) document.documentElement.classList.add('pf-inside');
