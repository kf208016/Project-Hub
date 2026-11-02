'use strict';
const fs = require('fs');
const path = require('path');
const { localPath } = require('./safe-path');
const scoped = require('./scoped-file');

const BS = String.fromCharCode(92);

function fail() {
  const e = new Error('native profile unavailable');
  e.code = 'NATIVE_PROFILE_UNAVAILABLE';
  throw e;
}

const RESERVED = new Set([
  'CON','PRN','AUX','NUL',
  'COM1','COM2','COM3','COM4','COM5','COM6','COM7','COM8','COM9',
  'LPT1','LPT2','LPT3','LPT4','LPT5','LPT6','LPT7','LPT8','LPT9',
  'COM\u00b9','COM\u00b2','COM\u00b3','LPT\u00b9','LPT\u00b2','LPT\u00b3'
]);

function hasControlOrSurrogate(str) {
  for (let i = 0; i < str.length; i++) {
    const cp = str.charCodeAt(i);
    if (cp <= 31 || cp === 127) return true;
    if (cp >= 0xD800 && cp <= 0xDFFF) {
      // check surrogate pairing validity
      if (cp >= 0xD800 && cp <= 0xDBFF) {
        const next = str.charCodeAt(i + 1);
        if (next >= 0xDC00 && next <= 0xDFFF) { i++; continue; }
        return true;
      }
      return true;
    }
  }
  return false;
}

const INVALID_CHARS = /[<>:"|?*]/;

function validateComponent(comp, isDrivePrefix) {
  if (comp.length === 0) return false;
  if (comp.length > 255) return false;
  if (hasControlOrSurrogate(comp)) return false;
  if (comp.indexOf('/') !== -1) return false;
  if (!isDrivePrefix) {
    if (INVALID_CHARS.test(comp)) return false;
  }
  if (/[ .]$/.test(comp)) return false;
  const base = comp.split('.')[0];
  if (RESERVED.has(base.toUpperCase())) return false;
  return true;
}

function validateCanonicalWindowsPath(p) {
  if (typeof p !== 'string') return false;
  if (p.length === 0 || p.length > 32760) return false;
  if (hasControlOrSurrogate(p)) return false;
  if (p.indexOf('/') !== -1) return false;
  if (p.indexOf(BS + BS) !== -1) return false;
  if (p.endsWith(BS)) return false;
  // must be drive absolute: letter:\...
  if (!/^[A-Za-z]:\\/.test(p)) return false;
  const drive = p.slice(0, 2);
  const rest = p.slice(3);
  if (rest.length === 0) return false;
  const parts = rest.split(BS);
  for (const part of parts) {
    if (part === '.' || part === '..') return false;
    if (!validateComponent(part, false)) return false;
  }
  return true;
}

function isDriveOrUsersRoot(p) {
  const parts = p.slice(3).split(BS).filter(x => x.length > 0);
  if (parts.length === 0) return true;
  if (parts.length === 1 && parts[0].toLowerCase() === 'users') return true;
  return false;
}

function checkRegularDir(p) {
  let st;
  try {
    st = fs.lstatSync(p);
  } catch (e) {
    fail();
  }
  if (!st || typeof st.isSymbolicLink !== 'function' || typeof st.isDirectory !== 'function') fail();
  if (st.isSymbolicLink()) fail();
  if (!st.isDirectory()) fail();
}

function readFingerprint(obj) {
  if (obj === null || typeof obj !== 'object') fail();
  const desc = Object.getOwnPropertyDescriptor(obj, 'rootFingerprint');
  if (!desc) fail();
  if (!('value' in desc)) fail();
  if (desc.get || desc.set) fail();
  const val = desc.value;
  if (typeof val !== 'string') fail();
  if (!/^[0-9a-f]{64}$/.test(val)) fail();
  return val;
}

async function resolve(ownerHome,{identity=file=>scoped.identity(file)}={}) {
  try {
    if (typeof ownerHome !== 'string') fail();
    if (!validateCanonicalWindowsPath(ownerHome)) fail();
    if (isDriveOrUsersRoot(ownerHome)) fail();

    let canonicalOwnerHome;
    try {
      canonicalOwnerHome = localPath(ownerHome);
    } catch (e) {
      fail();
    }
    if (typeof canonicalOwnerHome !== 'string' ||
        canonicalOwnerHome.toLowerCase() !== ownerHome.toLowerCase()) {
      fail();
    }
    checkRegularDir(ownerHome);

    const logicalBase = path.win32.join(ownerHome, 'AppData', 'Local', 'ProjectHub');
    if (!validateCanonicalWindowsPath(logicalBase)) fail();

    let canonicalLogicalBase;
    try {
      canonicalLogicalBase = localPath(logicalBase);
    } catch (e) {
      fail();
    }
    if (typeof canonicalLogicalBase !== 'string' ||
        canonicalLogicalBase.toLowerCase() !== logicalBase.toLowerCase()) {
      fail();
    }
    checkRegularDir(logicalBase);

    let rawPhysical;
    try {
      rawPhysical = fs.realpathSync.native(logicalBase);
    } catch (e) {
      fail();
    }
    if (typeof rawPhysical !== 'string') fail();
    if (!validateCanonicalWindowsPath(rawPhysical)) fail();

    let canonicalPhysical;
    try {
      canonicalPhysical = localPath(rawPhysical);
    } catch (e) {
      fail();
    }
    if (typeof canonicalPhysical !== 'string' ||
        canonicalPhysical.toLowerCase() !== rawPhysical.toLowerCase()) {
      fail();
    }
    checkRegularDir(rawPhysical);

    const physicalBase = rawPhysical;

    const sameAsLogical = physicalBase.toLowerCase() === logicalBase.toLowerCase();

    let allowed = sameAsLogical;
    if (!allowed) {
      const packagesPrefix = path.win32.join(ownerHome, 'AppData', 'Local', 'Packages') + BS;
      const suffix = BS + 'LocalCache' + BS + 'Local' + BS + 'ProjectHub';
      const pbLower = physicalBase.toLowerCase();
      const prefLower = packagesPrefix.toLowerCase();
      if (pbLower.startsWith(prefLower) && pbLower.endsWith(suffix.toLowerCase())) {
        const middle = physicalBase.slice(packagesPrefix.length, physicalBase.length - suffix.length);
        if (middle.indexOf(BS) === -1 && validateComponent(middle, false)) {
          allowed = true;
        }
      }
    }
    if (!allowed) fail();

    let identityResult;
    try {
      identityResult = await identity(physicalBase);
    } catch (e) {
      fail();
    }
    const rootFingerprint = readFingerprint(identityResult);

    const result = Object.freeze({
      logicalBase,
      physicalBase,
      rootFingerprint
    });
    return result;
  } catch {
    // Never inspect or reuse a dependency's thrown value: even its `code`
    // may be an accessor, and an existing matching error may contain secrets.
    fail();
  }
}

module.exports = { resolve };
