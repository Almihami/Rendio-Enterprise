// api-pines.js — Tienda de pines: la API (0181, 27-nov-2026).
//
// Todo lo que habla con la base para los pines pasa por aquí (window.ApiPines).
// La base es 0181_tienda_de_pines.sql:
//   · la tienda nace APAGADA; el jefe la enciende desde su pantalla Pines. Con
//     0182 tiene un término medio, «solo la tarjeta»: el tripulante ve el anuncio
//     en su Inicio y todavía no puede entrar ni reservar;
//   · en la app NO se paga: reservar aparta las unidades del inventario y les
//     avisa a los jefes. El pago y la entrega son en persona;
//   · cada pin tiene un estado: disponible, «Próximamente» (se ve y no se
//     reserva), «Agotado» u oculto. Disponible y sin unidades sale «Agotado» solo;
//   · el precio y la promo («2 por $30.000», solo al llevar exactamente 2) los
//     pone el jefe. La cuenta la hace
//     la BASE al reservar; total() de aquí es la misma fórmula, solo para mostrar
//     el valor mientras el tripulante arma su reserva;
//   · las tablas son de solo lectura para la sesión: todo se escribe con
//     funciones que revisan quién llama.
//
// Regla de la casa: si falta la función (base sin 0181) o no hay sesión, las
// lecturas devuelven null — nunca una tienda inventada. Los errores de verdad
// se lanzan con el texto de la base, que ya viene en español.
//
// Contrato (lo leen aux-rx-pines.js y admin-pines.js):
//   Tripulante: store, reserve, myReservations
//   Ayudas puras (sin red): total, money, imageUrl
//   Jefe: adminOverview, adminCounts, adminMarkSeen, adminSaveSettings,
//         adminSaveProduct, adminSetReservation, adminUploadImage
(function () {
  'use strict';

  const BUCKET = 'pins';
  const client = () => window.sb || null;

  // «Esto todavía no existe en esta base» (sin 0181): función, tabla o columna.
  function isMissing(e) {
    if (!e) return false;
    const code = String(e.code || '');
    if (/^(PGRST202|PGRST205|PGRST204|42883|42P01|42703)$/.test(code)) return true;
    return /Could not find the (function|table)|schema cache|does not exist/i.test(String(e.message || ''));
  }

  function toError(e) {
    const err = new Error((e && (e.message || e.hint || e.details)) || 'No pudimos completar la operación');
    if (e && e.code) err.code = e.code;
    return err;
  }

  async function hasSession() {
    const sb = client();
    if (!sb || !sb.auth) return false;
    try {
      const { data } = await sb.auth.getSession();
      return !!(data && data.session);
    } catch (e) { return false; }
  }

  // Lectura por RPC: null si no hay sesión o falta la función.
  async function readRpc(fn, args) {
    if (!(await hasSession())) return null;
    const { data, error } = await client().rpc(fn, args || {});
    if (error) { if (isMissing(error)) return null; throw toError(error); }
    return data;
  }

  // Acción por RPC: sin sesión o sin 0181 no se finge un éxito, se avisa.
  async function actRpc(fn, args) {
    if (!(await hasSession())) throw new Error('Tu sesión se cerró. Vuelve a entrar.');
    const { data, error } = await client().rpc(fn, args || {});
    if (error) {
      if (isMissing(error)) throw new Error('La tienda de pines todavía no está disponible');
      throw toError(error);
    }
    return data;
  }

  const int = (v, d = 0) => { const n = Number(v); return Number.isFinite(n) ? Math.trunc(n) : d; };

  // --------------------------------------------------------------------------
  // Ayudas puras
  // --------------------------------------------------------------------------
  // «$30.000»
  const money = (n) => '$' + String(Math.round(Number(n) || 0)).replace(/\B(?=(\d{3})+(?!\d))/g, '.');

  // Lo que valen `units` pines con los ajustes de la tienda (igual que
  // pin_total de la base). La promo aplica SOLO al llevar exactamente su
  // cantidad (Harold: «si compra 3 ya no aplica el descuento»): con «2 por
  // $30.000», 2 pines valen $30.000 y 3 valen 3 × $18.000.
  function total(units, s) {
    const n = Math.max(0, int(units));
    const unit = int(s && s.unitPriceCOP);
    const p = (s && s.promo) || {};
    if (p.on && p.qty >= 2 && p.priceCOP < p.qty * unit && n === p.qty) return p.priceCOP;
    return n * unit;
  }

  // «assets/pines/…» viene con la app; lo demás es un objeto del bucket `pins`.
  function imageUrl(path) {
    const p = String(path || '');
    if (!p) return '';
    if (/^assets\//.test(p)) return p;
    const sb = client();
    if (!sb || !sb.storage) return '';
    try {
      const { data } = sb.storage.from(BUCKET).getPublicUrl(p);
      return (data && data.publicUrl) || '';
    } catch (e) { return ''; }
  }

  // --------------------------------------------------------------------------
  // Formas
  // --------------------------------------------------------------------------
  function mapItem(i) {
    return {
      productId: (i && i.product_id) || null,
      name: (i && i.name) || 'Pin',
      imagePath: (i && i.image_path) || '',
      image: imageUrl(i && i.image_path),
      qty: int(i && i.qty, 1),
      unitPriceCOP: int(i && i.unit_price_cop),
    };
  }

  function mapReservation(r) {
    if (!r) return null;
    return {
      id: r.id,
      status: r.status || 'reserved',          // reserved | delivered | cancelled
      units: int(r.units),
      subtotalCOP: int(r.subtotal_cop),
      discountCOP: int(r.discount_cop),
      totalCOP: int(r.total_cop),
      promoLabel: r.promo_label || '',
      reservedAt: r.reserved_at || null,
      deliveredAt: r.delivered_at || null,
      cancelledAt: r.cancelled_at || null,
      cancelNote: r.cancel_note || '',
      items: (Array.isArray(r.items) ? r.items : []).map(mapItem),
      // Solo en la lista del jefe:
      crewName: r.crew_name || '',
      crewPhone: r.crew_phone || '',
      residence: r.residence || '',
      isNew: r.is_new === true,
    };
  }

  function mapStore(d) {
    if (!d) return null;
    const on = d.enabled === true;
    return {
      enabled: on,
      // 0182: encendida pero solo se ve la tarjeta de Inicio (sin entrar ni reservar).
      cardOnly: on && d.card_only === true,
      myPending: int(d.my_pending),
      title: d.title || 'Pines',
      cardText: d.card_text || '',
      storeNote: d.store_note || '',
      contactName: d.contact_name || '',
      unitPriceCOP: int(d.unit_price_cop),
      promo: { on: d.promo_on === true, qty: int(d.promo_qty, 2), priceCOP: int(d.promo_price_cop) },
      lowStockAt: int(d.low_stock_at),
      maxUnits: Math.max(1, int(d.max_units, 6)),
      products: (on && Array.isArray(d.products) ? d.products : []).map(p => ({
        id: p.id,
        name: p.name || 'Pin',
        description: p.description || '',
        imagePath: p.image_path || '',
        image: imageUrl(p.image_path),
        state: p.state === 'soon' || p.state === 'sold_out' ? p.state : 'available',
        stock: Math.max(0, int(p.stock)),
      })),
    };
  }

  function mapSettings(s) {
    if (!s) return null;
    return {
      enabled: s.enabled === true,
      // 0182. En una base que solo tiene 0181 el campo no llega: ahí no existe
      // «solo la tarjeta» y la pantalla del jefe no lo ofrece.
      cardOnly: s.card_only === true,
      cardOnlySupported: s.card_only !== undefined,
      title: s.title || '',
      cardText: s.card_text || '',
      storeNote: s.store_note || '',
      contactName: s.contact_name || '',
      unitPriceCOP: int(s.unit_price_cop),
      promoEnabled: s.promo_enabled === true,
      promoQty: int(s.promo_qty, 2),
      promoPriceCOP: int(s.promo_price_cop),
      lowStockAt: int(s.low_stock_at),
      maxUnits: int(s.max_units, 6),
    };
  }

  function mapProduct(p) {
    if (!p) return null;
    return {
      id: p.id,
      name: p.name || '',
      description: p.description || '',
      imagePath: p.image_path || '',
      image: imageUrl(p.image_path),
      status: p.status || 'soon',              // available | soon | sold_out | hidden
      stock: Math.max(0, int(p.stock)),
      sort: int(p.sort),
      reservedUnits: int(p.reserved_units),
      deliveredUnits: int(p.delivered_units),
    };
  }

  const mapCounts = (c) => (c ? { pending: int(c.pending), unseen: int(c.unseen) } : null);

  // Solo viajan las llaves que el llamador puso (la base deja lo demás como está).
  function pick(src, map) {
    const out = {};
    Object.keys(map).forEach(k => { if (src && src[k] !== undefined) out[map[k]] = src[k]; });
    return out;
  }

  // --------------------------------------------------------------------------
  // Tripulante
  // --------------------------------------------------------------------------
  // La tienda: null (sin sesión o sin 0181) | { enabled:false, myPending } |
  // { enabled:true, title, cardText, unitPriceCOP, promo, products:[…], … }
  async function store() {
    return mapStore(await readRpc('aux_pins_store'));
  }

  // items = [{ productId, qty }]. Devuelve { ok, reservation }.
  async function reserve(items) {
    const list = (Array.isArray(items) ? items : [])
      .filter(x => x && x.productId && int(x.qty) > 0)
      .map(x => ({ product_id: x.productId, qty: int(x.qty) }));
    if (!list.length) throw new Error('Elige al menos un pin');
    const d = await actRpc('aux_pins_reserve', { p_items: list });
    return { ok: !!(d && d.ok), reservation: mapReservation(d && d.reservation) };
  }

  async function myReservations() {
    const d = await readRpc('aux_pins_my_reservations');
    if (d == null) return null;
    return (Array.isArray(d) ? d : []).map(mapReservation);
  }

  // --------------------------------------------------------------------------
  // Jefe
  // --------------------------------------------------------------------------
  async function adminOverview() {
    const d = await readRpc('admin_pins_overview');
    if (d == null) return null;
    return {
      settings: mapSettings(d.settings),
      counts: mapCounts(d.counts) || { pending: 0, unseen: 0 },
      products: (Array.isArray(d.products) ? d.products : []).map(mapProduct),
      reservations: (Array.isArray(d.reservations) ? d.reservations : []).map(mapReservation),
    };
  }

  // Para el globo del menú. null si no es jefe o falta 0181.
  async function adminCounts() {
    return mapCounts(await readRpc('admin_pins_counts'));
  }

  async function adminMarkSeen() {
    return mapCounts(await actRpc('admin_pins_mark_seen'));
  }

  async function adminSaveSettings(patch) {
    const p = pick(patch, {
      enabled: 'enabled', cardOnly: 'card_only', title: 'title', cardText: 'card_text', storeNote: 'store_note',
      contactName: 'contact_name', unitPriceCOP: 'unit_price_cop', promoEnabled: 'promo_enabled',
      promoQty: 'promo_qty', promoPriceCOP: 'promo_price_cop', lowStockAt: 'low_stock_at', maxUnits: 'max_units',
    });
    return mapSettings(await actRpc('admin_pins_save_settings', { p }));
  }

  // Sin id crea un pin. stockDelta suma o resta; stock pone el valor exacto.
  async function adminSaveProduct(patch) {
    const p = pick(patch, {
      id: 'id', name: 'name', description: 'description', imagePath: 'image_path',
      status: 'status', stock: 'stock', stockDelta: 'stock_delta', sort: 'sort',
    });
    return mapProduct(await actRpc('admin_pins_save_product', { p }));
  }

  // action = 'deliver' | 'reopen' | 'cancel'. Devuelve { reservation, counts }.
  async function adminSetReservation(id, action, note) {
    const d = await actRpc('admin_pins_set_reservation', { p_id: id, p_action: action, p_note: note || null });
    return { reservation: mapReservation(d && d.reservation), counts: mapCounts(d && d.counts) };
  }

  async function myOrg() {
    // eslint-disable-next-line no-undef
    const g = typeof state !== 'undefined' ? state : null;
    if (g && g.profile && g.profile.organization_id) return g.profile.organization_id;
    const sb = client();
    const { data: ses } = await sb.auth.getSession();
    const uid = ses && ses.session && ses.session.user && ses.session.user.id;
    if (!uid) throw new Error('Tu sesión se cerró. Vuelve a entrar.');
    const { data, error } = await sb.from('profiles').select('organization_id').eq('id', uid).maybeSingle();
    if (error) throw toError(error);
    if (!data || !data.organization_id) throw new Error('No encontramos tu organización');
    return data.organization_id;
  }

  // Sube la imagen de un pin al bucket público `pins` y devuelve su ruta, que es
  // lo que se guarda en el pin (adminSaveProduct({ imagePath })).
  const IMG_TYPES = { 'image/png': 'png', 'image/webp': 'webp', 'image/jpeg': 'jpg' };
  async function adminUploadImage(file) {
    if (!file) throw new Error('Elige una imagen');
    const ext = IMG_TYPES[String(file.type || '').toLowerCase()];
    if (!ext) throw new Error('La imagen debe ser PNG, WebP o JPG');
    if (file.size > 2 * 1024 * 1024) throw new Error('La imagen pesa más de 2 MB. Usa una más liviana.');
    if (!(await hasSession())) throw new Error('Tu sesión se cerró. Vuelve a entrar.');
    const org = await myOrg();
    const name = 'pin-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8) + '.' + ext;
    const path = org + '/' + name;
    const up = await client().storage.from(BUCKET).upload(path, file, { contentType: file.type, upsert: false });
    if (up && up.error) {
      if (/bucket not found/i.test(String(up.error.message || ''))) throw new Error('La tienda de pines todavía no está disponible');
      throw toError(up.error);
    }
    return path;
  }

  window.ApiPines = {
    store, reserve, myReservations,
    total, money, imageUrl,
    adminOverview, adminCounts, adminMarkSeen, adminSaveSettings, adminSaveProduct,
    adminSetReservation, adminUploadImage,
  };
})();
