(function (global) {
  'use strict';

  const PLAN_KEY = 'material-plan-v8';

  function read(key, fallback) {
    try {
      const value = JSON.parse(localStorage.getItem(key) || 'null');
      return value == null ? fallback : value;
    } catch (e) { return fallback; }
  }

  function write(key, value) { localStorage.setItem(key, JSON.stringify(value)); }
  function now() {
    const d = new Date(), p = n => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
  }
  function deliveryCode(value) { return value === 'direct' || value === '直送' ? 'direct' : 'self'; }
  function deliveryText(value) { return deliveryCode(value) === 'direct' ? '直送' : '自提'; }
  function hasValue(value) { return value !== null && value !== undefined && value !== ''; }
  function asnGroupKey(row) {
    return `${String(row.sapSupplierCode || row.supplierName || '').trim()}|${String(row.arrivalDate || '').trim()}`;
  }
  function defaultAsnNo(row, rows = []) {
    const digits = String(row.arrivalDate || row.shipDate || '').replace(/\D/g, '');
    const dateCode = digits.length >= 8 ? digits.slice(2, 8) : (() => {
      const d = new Date(), p = n => String(n).padStart(2, '0');
      return `${String(d.getFullYear()).slice(-2)}${p(d.getMonth() + 1)}${p(d.getDate())}`;
    })();
    const used = new Set((rows || []).map(r => String(r.asnNo || '')).filter(no => no.startsWith(`ASN-${dateCode}-`)));
    for (let seq = 1; seq <= 999; seq++) {
      const candidate = `ASN-${dateCode}-${String(seq).padStart(3, '0')}`;
      if (!used.has(candidate)) return candidate;
    }
    throw new Error(`ASN-${dateCode} 当日流水号已用尽`);
  }
  const LEGACY_DEMO_ASN_RE = /^(?:ASN\d{4}|PLAN-\d{4}-\d{3}|DD-\d{4}-\d{3}|SP-\d{4}-\d{3})$/;
  function remapAsnReferences(remap) {
    if (!remap.size) return;
    const packaging = read('bw-asn-packaging-v1', {});
    let packagingChanged = false;
    remap.forEach((nextNo, oldNo) => {
      if (!Object.prototype.hasOwnProperty.call(packaging, oldNo)) return;
      if (!Object.prototype.hasOwnProperty.call(packaging, nextNo)) packaging[nextNo] = packaging[oldNo];
      delete packaging[oldNo];
      packagingChanged = true;
    });
    if (packagingChanged) write('bw-asn-packaging-v1', packaging);

    ['bw_supplier_deliveries', 'bw_carrier_pickups', 'bw_supplier_inspections'].forEach(key => {
      const records = read(key, []);
      if (!Array.isArray(records)) return;
      let changed = false;
      records.forEach(record => {
        ['asnNo', 'no'].forEach(field => {
          if (remap.has(record[field])) { record[field] = remap.get(record[field]); changed = true; }
        });
        if (Array.isArray(record.items)) record.items.forEach(item => {
          if (remap.has(item.asnNo)) { item.asnNo = remap.get(item.asnNo); changed = true; }
        });
      });
      if (changed) write(key, records);
    });
  }
  // 只迁移旧原型自带的演示编号；SAP 导入编号保持原值。
  function migrateLegacyDemoAsns(rows) {
    const groups = new Map(), remap = new Map();
    rows.forEach(row => {
      if (row.asnSource === 'sap' || !LEGACY_DEMO_ASN_RE.test(String(row.asnNo || ''))) return;
      const key = asnGroupKey(row);
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(row);
    });
    groups.forEach(items => {
      const nextNo = defaultAsnNo(items[0], rows);
      items.forEach(row => { remap.set(row.asnNo, nextNo); row.asnNo = nextNo; });
    });
    remapAsnReferences(remap);
    return remap.size;
  }
  // ASN 主单维度：同一供应商 + 同一计划到货日期 = 同一 ASN。
  function normalizeAsnGroups(rows) {
    const groups = new Map(), owner = new Map();
    rows.forEach(row => {
      if (!row.arrivalDate || !row.asnNo) return;
      const key = asnGroupKey(row);
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(row);
    });
    groups.forEach((items, key) => {
      let asnNo = items.find(r => r.asnNo)?.asnNo;
      if (!asnNo) return;
      if (owner.has(asnNo) && owner.get(asnNo) !== key) asnNo = defaultAsnNo(items[0], rows);
      owner.set(asnNo, key);
      // ASN 只统一批次标识；配送方式和物流商保留在物料明细维度，
      // 因此同一 ASN 内可同时包含直送与自提物料。
      items.forEach(r => { r.asnNo = asnNo; r.asnGroupKey = key; });
    });
    return rows;
  }

  // Meeting 2026-09-14: supplier owns personnel and ASN delivery configuration.
  function supplierFor(row) {
    const list=read('bw-suppliers',[]);
    return Array.isArray(list)?list.find(s=>String(s.code)===String(row.sapSupplierCode||row.supplierCode||'')):null;
  }
  function applySupplier(row, imported=false) {
    const supplier=supplierFor(row); if(!supplier)return row;
    row.planner=supplier.planner||''; row.inspector=supplier.inspector||'';
    const frozen=['in_transit','received','cancelled'].includes(row.status)||row.appointmentStatus==='scheduled'||row.deliveryAppointmentDate;
    if(!frozen){row.deliveryMode=supplier.deliveryMode||'直送';row.logistics=supplier.carrier||'';row.supplierConfigApplied=true;}
    if(imported && supplier.supplierShipmentBased && hasValue(row.promisedQty) && !frozen){
      row.originalPlanQty=row.originalPlanQty??row.planQty;
      row.planQty=Number(row.promisedQty);row.confirmQty=Number(row.promisedQty);
      row.status='pending_shipment';row.autoConfirmedAt=now();row.confirmationSource='supplier-asn-switch';
    }
    return row;
  }
  function packaging(asnNo) {
    const rows=loadRows().filter(r=>r.asnNo===asnNo);
    const suggested=field=>rows.every(r=>Number(r[field])>0)?rows.reduce((n,r)=>n+Math.ceil(Number(r.confirmQty??r.promisedQty??r.planQty)/Number(r[field])),0):null;
    const saved=read('bw-asn-packaging-v1',{})[asnNo]||{};
    return {suggestedBoxes:suggested('perBoxQty'),suggestedPallets:suggested('perPalletQty'),batchNo:rows[0]?.batchNo||'',...saved};
  }
  function savePackaging(asnNo,boxes,pallets,batchNo='') {
    if(![boxes,pallets].every(n=>Number.isSafeInteger(n)&&n>=0))throw Error('箱数和托数必须为非负整数');
    const db=read('bw-asn-packaging-v1',{});db[asnNo]={boxes,pallets,batchNo};write('bw-asn-packaging-v1',db);
    patchAsn(asnNo,{batchNo});
  }
  function migrateRow(row) {
    const r = applySupplier({ ...row });
    r.deliveryMode = deliveryText(r.deliveryMode || 'direct');
    r.appointmentStatus = r.appointmentStatus || 'none';
    r.appointmentDate = r.appointmentDate || '';
    r.appointmentSlot = r.appointmentSlot || '';
    r.deliveryAppointmentDate = r.deliveryAppointmentDate || '';
    r.actualShipQty = hasValue(r.actualShipQty) ? Number(r.actualShipQty) : null;
    r.actualArrivalQty = hasValue(r.actualArrivalQty) ? Number(r.actualArrivalQty) : null;
    if (!r.asnNo || !hasValue(r.promisedQty) || ['cancelled', 'in_transit', 'received', 'pending_shipment', 'planner_adjustment'].includes(r.status)) return r;
    // ASN 导入后：数量一致直接待供应商确认；有差异必须先经工厂确认。
    if (!r.factoryConfirmedAt) r.status = Number(r.planQty) === Number(r.promisedQty) ? 'supplier_pending' : 'platform_pending';
    return r;
  }

  function loadRows() {
    const rows = read(PLAN_KEY, []);
    if (!Array.isArray(rows)) return [];
    const migrated = rows.map(migrateRow);
    const changed = migrateLegacyDemoAsns(migrated);
    normalizeAsnGroups(migrated);
    if (changed) write(PLAN_KEY, migrated);
    return migrated;
  }
  function saveRows(rows) { write(PLAN_KEY, normalizeAsnGroups(rows.map(r=>applySupplier(r)))); }
  function byAsn(rows) {
    const map = new Map();
    normalizeAsnGroups(rows || []).filter(r => r.asnNo).forEach(r => {
      if (!map.has(r.asnNo)) map.set(r.asnNo, []);
      map.get(r.asnNo).push(r);
    });
    return [...map.entries()].map(([asnNo, items]) => ({
      asnNo, items,
      supplierName: items[0].supplierName || '',
      supplierCode: items[0].sapSupplierCode || '',
      voucher: [...new Set(items.map(r => r.voucher).filter(Boolean))].join(' / '),
      shipDate: items.map(r => r.shipDate).filter(Boolean).sort()[0] || '',
      arrivalDate: items.map(r => r.arrivalDate).filter(Boolean).sort()[0] || '',
      deliveryAppointmentDate: items.map(r => r.deliveryAppointmentDate).filter(Boolean).sort()[0] || '',
      stockReadyTime: items.map(r => r.stockReadyTime).filter(Boolean).sort().at(-1) || '',
      vehiclePlate: items.map(r => r.vehiclePlate).find(Boolean) || '',
      pickupPerson: items.map(r => r.pickupPerson).find(Boolean) || '',
      pickupPhone: items.map(r => r.pickupPhone).find(Boolean) || '',
      deliveryMode: deliveryText(items[0].deliveryMode),
      logistics: items[0].logistics || '',
      planQty: items.reduce((s, r) => s + (Number(r.planQty) || 0), 0),
      promisedQty: items.reduce((s, r) => s + (Number(r.promisedQty) || 0), 0),
      actualShipQty: items.reduce((s, r) => s + (Number(r.actualShipQty) || 0), 0),
      actualArrivalQty: items.reduce((s, r) => s + (Number(r.actualArrivalQty) || 0), 0)
    }));
  }
  function patchAsn(asnNo, patch) {
    const rows = loadRows();
    rows.forEach(r => {
      if (r.asnNo !== asnNo) return;
      Object.assign(r, typeof patch === 'function' ? patch(r) : patch, { updatedAt: now() });
    });
    saveRows(rows);
    return rows;
  }
  function recordsForSupplier() {
    // 兼容升级前已完成的物流商取货登记：旧记录仅保存在移动端取货单中，
    // 供应商页面读取时按 ASN 补齐车辆信息，避免历史数据出现空车牌。
    const pickupByAsn = new Map();
    const pickupRecords = read('bw_carrier_pickups', []);
    if (Array.isArray(pickupRecords)) {
      pickupRecords.forEach(rec => {
        const asnNo = rec.asnNo || rec.no;
        if (asnNo && !pickupByAsn.has(asnNo)) pickupByAsn.set(asnNo, rec);
      });
    }
    return loadRows().filter(r => r.asnNo && hasValue(r.promisedQty) && !['cancelled', 'planner_adjustment'].includes(r.status)).map(r => ({
      id: r.id, asnNo: r.asnNo, materialName: r.materialName || r.materialCode,
      shipDate: r.shipDate || '', arriveDate: r.arrivalDate || '', materialCode: r.materialCode,
      poNumber: r.voucher || '', supplierCode: r.sapSupplierCode || '', supplierName: r.supplierName || '',
      planQty: Number(r.planQty || 0).toLocaleString('zh-CN'), planQtyNum: Number(r.planQty || 0),
      stdBoxQty: Number(r.perBoxQty || 0), stdPalletQty: Number(r.perPalletQty || 0),
      commitQty: hasValue(r.confirmQty) ? Number(r.confirmQty).toLocaleString('zh-CN') : Number(r.promisedQty || 0).toLocaleString('zh-CN'),
      commitQtyNum: Number(hasValue(r.confirmQty) ? r.confirmQty : r.promisedQty || 0),
      commitShipDate: r.commitShipDate || r.shipDate || '', commitArriveDate: r.commitArriveDate || r.arrivalDate || '',
      boxCount: Number(r.boxCount || 0), palletCount: Number(r.palletCount || 0), updateTime: r.updatedAt || '',
      status: r.status === 'platform_pending' ? 'platformPending' : r.status === 'supplier_pending' ? 'pending' : r.status === 'pending_shipment' ? (r.stockReadyTime ? 'awaitPickup' : 'confirmed') : r.status === 'in_transit' ? 'shipped' : r.status,
      deliveryMethod: deliveryCode(r.deliveryMode), designatedLogistics: r.logistics || '', warehouseArea: r.warehouseArea || '1号库区',
      appointmentStatus: r.appointmentStatus || 'none', appointmentDate: r.appointmentDate || '', appointmentSlot: r.appointmentSlot || '',
      appointmentQty: hasValue(r.appointmentQty) ? Number(r.appointmentQty) : null,
      appointmentPalletQty: hasValue(r.appointmentPalletQty) ? Number(r.appointmentPalletQty) : null,
      logisticsProvider: r.logisticsProvider || pickupByAsn.get(r.asnNo)?.carrier || r.logistics || '',
      pickupPerson: r.pickupPerson || pickupByAsn.get(r.asnNo)?.driver || '', pickupPhone: r.pickupPhone || '',
      vehiclePlate: r.vehiclePlate || r.plate || pickupByAsn.get(r.asnNo)?.plate || '',
      actionHistory: Array.isArray(r.actionHistory) ? r.actionHistory : [],
      deliveryAppointmentDate: r.deliveryAppointmentDate || pickupByAsn.get(r.asnNo)?.eta || '', actualShipQty: r.actualShipQty
    }));
  }
  function saveSupplierRecords(records) {
    const rows = loadRows();
    const map = new Map(records.map(r => [r.id, r]));
    rows.forEach(row => {
      const r = map.get(row.id); if (!r) return;
      row.confirmQty = r.commitQtyNum;
      row.deliveryMode = deliveryText(r.deliveryMethod);
      row.logistics = r.designatedLogistics || row.logistics || '';
      row.commitShipDate = r.commitShipDate || row.shipDate;
      row.commitArriveDate = r.commitArriveDate || row.arrivalDate;
      row.boxCount = r.boxCount; row.palletCount = r.palletCount;
      row.appointmentStatus = r.appointmentStatus || 'none'; row.appointmentDate = r.appointmentDate || '';
      row.appointmentQty = hasValue(r.appointmentQty) ? Number(r.appointmentQty) : null;
      row.appointmentPalletQty = hasValue(r.appointmentPalletQty) ? Number(r.appointmentPalletQty) : null;
      row.appointmentSlot = r.appointmentSlot || '';
      row.stockReadyTime = r.stockReadyTime || row.stockReadyTime || '';
      row.logisticsProvider = r.logisticsProvider || row.logisticsProvider || '';
      row.pickupPerson = r.pickupPerson || row.pickupPerson || ''; row.pickupPhone = r.pickupPhone || row.pickupPhone || '';
      row.vehiclePlate = r.vehiclePlate || row.vehiclePlate || '';
      row.deliveryAppointmentDate = r.deliveryAppointmentDate || row.deliveryAppointmentDate || '';
      if (Array.isArray(r.actionHistory)) row.actionHistory = r.actionHistory;
      row.status = r.status === 'platformPending' ? 'platform_pending' : r.status === 'pending' ? 'supplier_pending' : ['confirmed', 'awaitPickup'].includes(r.status) ? 'pending_shipment' : r.status === 'shipped' ? 'in_transit' : r.status;
      if (r.status === 'confirmed' && !row.supplierConfirmedAt) row.supplierConfirmedAt = now();
      row.updatedAt = r.updateTime || now();
    });
    saveRows(rows);
  }

  global.LogisticsFlow = { supplierFor, applySupplier, packaging, savePackaging, PLAN_KEY, read, write, now, loadRows, saveRows, byAsn, patchAsn, recordsForSupplier, saveSupplierRecords, deliveryCode, deliveryText, hasValue, asnGroupKey, defaultAsnNo, normalizeAsnGroups };
})(window);
