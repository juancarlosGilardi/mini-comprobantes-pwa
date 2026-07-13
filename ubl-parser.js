// Puerto de backend/ubl_parser.py — parser de comprobantes UBL 2.1 (Clave SOL) en el navegador.
const NS = {
  cbc: "urn:oasis:names:specification:ubl:schema:xsd:CommonBasicComponents-2",
  cac: "urn:oasis:names:specification:ubl:schema:xsd:CommonAggregateComponents-2",
  ds: "http://www.w3.org/2000/09/xmldsig#",
};

const TIPO_CPE = {
  "01": "FACTURA ELECTRÓNICA", "03": "BOLETA DE VENTA ELECTRÓNICA",
  "07": "NOTA DE CRÉDITO ELECTRÓNICA", "08": "NOTA DE DÉBITO ELECTRÓNICA",
};
const MOTIVOS_NC = {
  "01": "Anulación de la operación", "02": "Anulación por error en el RUC",
  "03": "Corrección por error en la descripción", "04": "Descuento global",
  "05": "Descuento por ítem", "06": "Devolución total", "07": "Devolución por ítem",
  "08": "Bonificación", "09": "Disminución en el valor", "10": "Otros conceptos",
  "11": "Ajustes de operaciones de exportación", "12": "Ajustes afectos al IVAP",
};
const MOTIVOS_ND = {
  "01": "Intereses por mora", "02": "Aumento en el valor",
  "03": "Penalidades / otros conceptos",
  "11": "Ajustes de operaciones de exportación", "12": "Ajustes afectos al IVAP",
};
const MOTIVO_RETENCION = "62";
const CATALOGO_54_DETRACCION = {
  "001": "Azúcar y melaza de caña", "002": "Arroz", "003": "Alcohol etílico",
  "004": "Recursos hidrobiológicos", "005": "Maíz amarillo duro", "007": "Caña de azúcar",
  "008": "Madera", "009": "Arena y piedra",
  "010": "Residuos, subproductos, desechos, recortes y desperdicios",
  "011": "Bienes gravados con el IGV, o renuncia a la exoneración",
  "012": "Intermediación laboral y tercerización", "013": "Animales vivos",
  "014": "Carnes y despojos comestibles", "015": "Abonos, cueros y pieles de origen animal",
  "016": "Aceite de pescado", "017": "Harina, polvo y pellets de pescado, crustáceos, moluscos",
  "019": "Arrendamiento de bienes muebles", "020": "Mantenimiento y reparación de bienes muebles",
  "021": "Movimiento de carga", "022": "Otros servicios empresariales", "023": "Leche",
  "024": "Comisión mercantil", "025": "Fabricación de bienes por encargo",
  "026": "Servicio de transporte de personas", "027": "Servicio de transporte de carga",
  "028": "Transporte de pasajeros", "030": "Contratos de construcción",
  "031": "Oro gravado con el IGV", "032": "Paprika y otros frutos del género capsicum",
  "034": "Minerales metálicos no auríferos", "035": "Bienes exonerados del IGV",
  "036": "Oro y demás minerales metálicos exonerados",
  "037": "Demás servicios gravados con el IGV", "039": "Minerales no metálicos",
  "040": "Bien inmueble gravado con IGV", "041": "Plomo", "099": "Ley 30737",
};
const CATALOGO_59_MEDIO_PAGO = {
  "001": "Depósito en cuenta", "002": "Giro", "003": "Transferencia de fondos",
  "004": "Orden de pago", "005": "Tarjeta de débito",
  "006": "Tarjeta de crédito emitida en el país", "007": "Cheque no negociable",
  "008": "Efectivo, sin obligación de usar medio de pago", "009": "Efectivo, demás casos",
  "010": "Medios de pago de comercio exterior", "999": "Otros medios de pago",
};
const TAX_SCHEME = { "1000": "gravado", "9997": "exonerado", "9998": "inafecto", "9996": "gratuito", "7152": "icbper" };

function dec(s) {
  const n = parseFloat(String(s ?? "").trim());
  return Number.isFinite(n) ? n : 0;
}

function childrenNS(node, ns, local) {
  if (!node) return [];
  return Array.from(node.children).filter((ch) => ch.localName === local && ch.namespaceURI === ns);
}

function find(node, path) {
  if (!node) return null;
  let recursive = false;
  let p = path;
  if (p.startsWith(".//")) { recursive = true; p = p.slice(3); }
  const steps = p.split("/");
  let current = node;
  for (let i = 0; i < steps.length; i++) {
    const [prefix, local] = steps[i].split(":");
    const ns = NS[prefix];
    if (i === 0 && recursive) {
      const found = current.getElementsByTagNameNS(ns, local);
      current = found.length ? found[0] : null;
    } else {
      current = childrenNS(current, ns, local)[0] || null;
    }
    if (!current) return null;
  }
  return current;
}

function findAll(node, path) {
  if (!node) return [];
  let recursive = false;
  let p = path;
  if (p.startsWith(".//")) { recursive = true; p = p.slice(3); }
  const steps = p.split("/");
  let current = [node];
  for (let i = 0; i < steps.length; i++) {
    const [prefix, local] = steps[i].split(":");
    const ns = NS[prefix];
    let next = [];
    for (const c of current) {
      if (i === 0 && recursive) {
        next.push(...Array.from(c.getElementsByTagNameNS(ns, local)));
      } else {
        next.push(...childrenNS(c, ns, local));
      }
    }
    current = next;
  }
  return current;
}

function txt(node, path) {
  const el = find(node, path);
  return el ? (el.textContent || "").trim() : "";
}

function serieNumero(idStr) {
  const s = (idStr || "").trim();
  const m = s.split(/\s*-\s*/);
  if (m.length >= 2) return [m[0].trim(), m.slice(1).join("-").trim()];
  return [s, ""];
}

function direccion(partyNode) {
  if (!partyNode) return "";
  const linea = txt(partyNode, ".//cac:RegistrationAddress/cac:AddressLine/cbc:Line");
  if (linea) return linea;
  const partes = [
    txt(partyNode, ".//cac:RegistrationAddress/cbc:StreetName"),
    txt(partyNode, ".//cac:RegistrationAddress/cbc:District"),
    txt(partyNode, ".//cac:RegistrationAddress/cbc:CityName"),
  ];
  return partes.filter((p) => p).join(" - ");
}

function parsear(root) {
  const cpeId = txt(root, ".//cbc:ID");
  const [serie, numero] = cpeId.split("-").length > 1
    ? [cpeId.split("-")[0], cpeId.split("-").slice(1).join("-")]
    : [cpeId, ""];
  const raiz = (root.localName || root.tagName || "").toLowerCase();

  let tipo;
  if (raiz.includes("creditnote")) tipo = "07";
  else if (raiz.includes("debitnote")) tipo = "08";
  else tipo = txt(root, ".//cbc:InvoiceTypeCode") || txt(root, ".//cbc:DocumentTypeCode");

  let referencia = {};
  let motivo = {};
  if (tipo === "07" || tipo === "08") {
    const refNode = find(root, "cac:BillingReference/cac:InvoiceDocumentReference");
    if (refNode) {
      const [refSerie, refNumero] = serieNumero(txt(refNode, "cbc:ID"));
      const refTipoDoc = txt(refNode, "cbc:DocumentTypeCode");
      referencia = {
        tipo_doc: refTipoDoc,
        tipo_doc_desc: TIPO_CPE[refTipoDoc] || "",
        serie: refSerie, numero: refNumero,
        fecha: txt(refNode, "cbc:IssueDate"),
      };
    }
    const disc = find(root, "cac:DiscrepancyResponse");
    const motivoCodigo = (disc ? txt(disc, "cbc:ResponseCode") : "")
      || txt(root, "cbc:CreditNoteTypeCode")
      || txt(root, "cbc:DebitNoteTypeCode");
    if (motivoCodigo) {
      const catalogo = tipo === "07" ? MOTIVOS_NC : MOTIVOS_ND;
      motivo = {
        codigo: motivoCodigo,
        descripcion: catalogo[motivoCodigo] || (disc ? txt(disc, "cbc:Description") : ""),
      };
    }
  }

  let retencion = {};
  for (const ac of findAll(root, "cac:AllowanceCharge")) {
    if (txt(ac, "cbc:AllowanceChargeReasonCode") === MOTIVO_RETENCION) {
      retencion = {
        base_imponible: dec(txt(ac, "cbc:BaseAmount")),
        porcentaje: dec(txt(ac, "cbc:MultiplierFactorNumeric")) * 100,
        monto: dec(txt(ac, "cbc:Amount")),
      };
      break;
    }
  }

  let detraccion = {};
  const ptDet = findAll(root, "cac:PaymentTerms").find((pt) => txt(pt, "cbc:ID").toLowerCase() === "detraccion");
  if (ptDet) {
    const codBien = txt(ptDet, "cbc:PaymentMeansID");
    const pmDet = findAll(root, "cac:PaymentMeans").find((pm) => txt(pm, "cbc:ID").toLowerCase() === "detraccion");
    const codMedio = pmDet ? txt(pmDet, "cbc:PaymentMeansCode") : "";
    detraccion = {
      bien_codigo: codBien,
      bien_desc: CATALOGO_54_DETRACCION[codBien] || "",
      medio_codigo: codMedio,
      medio_desc: CATALOGO_59_MEDIO_PAGO[codMedio] || "",
      cuenta: pmDet ? txt(pmDet, "cac:PayeeFinancialAccount/cbc:ID") : "",
      porcentaje: dec(txt(ptDet, "cbc:PaymentPercent")),
      monto: dec(txt(ptDet, "cbc:Amount")),
    };
  }

  const leyendas = findAll(root, "cbc:Note")
    .filter((note) => {
      const loc = note.getAttribute("languageLocaleID");
      return loc !== null && loc !== "1000" && loc !== "2006" && (note.textContent || "").trim();
    })
    .map((note) => (note.textContent || "").trim());

  const emisor = find(root, ".//cac:AccountingSupplierParty");
  const receptor = find(root, ".//cac:AccountingCustomerParty");

  let cliIdNode = null;
  if (receptor) {
    cliIdNode = find(receptor, ".//cac:PartyIdentification/cbc:ID");
    if (!cliIdNode) cliIdNode = find(receptor, ".//cbc:CustomerAssignedAccountID");
  }
  const clienteDoc = cliIdNode ? (cliIdNode.textContent || "").trim() : "";
  let clienteTipoDoc = cliIdNode ? (cliIdNode.getAttribute("schemeID") || "").trim() : "";
  if (!clienteTipoDoc && clienteDoc) {
    clienteTipoDoc = clienteDoc.length === 11 ? "6" : clienteDoc.length === 8 ? "1" : "0";
  }

  const hashNode = find(root, ".//ds:DigestValue");
  const hashXml = hashNode ? (hashNode.textContent || "").trim() : "";

  const totales = { gravado: 0, exonerado: 0, inafecto: 0, gratuito: 0, icbper: 0 };
  let igv = 0;
  for (const st of findAll(root, "cac:TaxTotal/cac:TaxSubtotal")) {
    const scheme = txt(st, ".//cac:TaxScheme/cbc:ID");
    const cubeta = TAX_SCHEME[scheme];
    if (cubeta === "icbper") {
      totales.icbper += dec(txt(st, "cbc:TaxAmount"));
    } else if (cubeta) {
      totales[cubeta] += dec(txt(st, "cbc:TaxableAmount"));
    }
    if (scheme === "1000") igv += dec(txt(st, "cbc:TaxAmount"));
  }
  if (igv === 0) igv = dec(txt(root, "cac:TaxTotal/cbc:TaxAmount"));

  let total = dec(txt(root, ".//cac:LegalMonetaryTotal/cbc:PayableAmount"));
  if (totales.gravado === 0 && totales.exonerado === 0 && totales.inafecto === 0) {
    totales.gravado = dec(txt(root, ".//cac:LegalMonetaryTotal/cbc:LineExtensionAmount"));
  }

  let formaPago = "";
  for (const pt of findAll(root, ".//cac:PaymentTerms")) {
    if (txt(pt, "cbc:ID").toLowerCase() === "formapago") {
      const v = txt(pt, "cbc:PaymentMeansID");
      if (["contado", "credito", "crédito"].includes(v.toLowerCase())) {
        formaPago = v.toUpperCase();
        break;
      }
    }
  }

  const out = {
    ok: true,
    tipo,
    tipo_desc: TIPO_CPE[tipo] || "COMPROBANTE ELECTRÓNICO",
    serie, numero,
    fecha: txt(root, ".//cbc:IssueDate"),
    hora: txt(root, ".//cbc:IssueTime"),
    moneda: txt(root, ".//cbc:DocumentCurrencyCode"),
    hash_xml: hashXml,
    forma_pago: formaPago || "CONTADO",
    referencia, motivo, retencion, detraccion, leyendas,
    emisor: {
      ruc: txt(emisor, ".//cbc:ID") || txt(emisor, ".//cbc:CustomerAssignedAccountID"),
      nombre: txt(emisor, ".//cbc:RegistrationName"),
      nombre_comercial: txt(emisor, ".//cbc:Name"),
      direccion: direccion(emisor),
    },
    cliente: {
      tipo_doc: clienteTipoDoc,
      doc: clienteDoc,
      nombre: txt(receptor, ".//cbc:RegistrationName"),
      direccion: direccion(receptor),
    },
    gravado: totales.gravado, exonerado: totales.exonerado, inafecto: totales.inafecto,
    gratuito: totales.gratuito, icbper: totales.icbper, igv, total,
    lineas: [],
  };

  let lineas = findAll(root, ".//cac:InvoiceLine");
  if (!lineas.length) lineas = findAll(root, ".//cac:CreditNoteLine");
  if (!lineas.length) lineas = findAll(root, ".//cac:DebitNoteLine");

  lineas.forEach((ln, idx) => {
    let qtyNode = find(ln, "cbc:InvoicedQuantity")
      || find(ln, "cbc:CreditedQuantity")
      || find(ln, "cbc:DebitedQuantity");
    const cantidad = dec(qtyNode ? qtyNode.textContent : "");
    const unidad = (qtyNode ? qtyNode.getAttribute("unitCode") : "") || "";
    const item = find(ln, "cac:Item");
    let precioConIgv = 0;
    for (const alt of findAll(ln, "cac:PricingReference/cac:AlternativeConditionPrice")) {
      if (txt(alt, "cbc:PriceTypeCode") === "01") {
        precioConIgv = dec(txt(alt, "cbc:PriceAmount"));
        break;
      }
    }
    out.lineas.push({
      n: idx + 1,
      codigo: txt(item, "cac:SellersItemIdentification/cbc:ID"),
      descripcion: txt(item, "cbc:Description"),
      unidad, cantidad,
      valor_unit: dec(txt(ln, "cac:Price/cbc:PriceAmount")),
      precio_con_igv: precioConIgv,
      valor_venta: dec(txt(ln, "cbc:LineExtensionAmount")),
      igv: dec(txt(ln, "cac:TaxTotal/cbc:TaxAmount")),
    });
  });

  return out;
}

function parsearXmlTexto(xmlTexto) {
  const doc = new DOMParser().parseFromString(xmlTexto, "application/xml");
  const errorNode = doc.querySelector("parsererror");
  if (errorNode) return { ok: false, error: "XML inválido: " + errorNode.textContent.slice(0, 200) };
  return parsear(doc.documentElement);
}

window.ublParser = { parsearXmlTexto };
