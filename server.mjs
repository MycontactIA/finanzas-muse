// Servidor MCP de solo lectura para Finanzas Pro (conector de Muse).
// Requiere Node 18+. Sin dependencias externas.
//
// Variables de entorno:
//   FP_API_URL   URL de la app web de Apps Script (termina en /exec)
//   FP_USUARIO   usuario de Finanzas Pro
//   FP_PASS      contraseña (solo en el servidor, nunca se expone a Muse)
//   MCP_TOKEN    token secreto que Muse debe enviar en la cabecera Authorization
//   PORT         puerto (por defecto 8080)

import http from "node:http";

const { FP_API_URL, FP_USUARIO, FP_PASS, MCP_TOKEN, PORT = 8080 } = process.env;
if (!FP_API_URL || !FP_USUARIO || !FP_PASS || !MCP_TOKEN) {
  console.error("Faltan variables de entorno: FP_API_URL, FP_USUARIO, FP_PASS, MCP_TOKEN");
  process.exit(1);
}

// Sesión de Finanzas Pro guardada en memoria del servidor.
let sesionFP = null; // { token, expira }

async function llamarApi(accion, datos = {}, token = "") {
  const r = await fetch(FP_API_URL, {
    method: "POST",
    headers: { "Content-Type": "text/plain;charset=utf-8" }, // evita preflight CORS en Apps Script
    body: JSON.stringify({ accion, token, datos }),
    redirect: "follow",
  });
  const j = await r.json();
  if (!j.ok) throw new Error(j.error?.mensaje || "Error de la API");
  return j.datos;
}

async function obtenerToken() {
  if (sesionFP && sesionFP.expira > Date.now()) return sesionFP.token;
  const datos = await llamarApi("login", { usuario: FP_USUARIO, pass: FP_PASS });
  // Apps Script/Finanzas Pro devuelve el token; ajustar si la respuesta usa otro nombre.
  sesionFP = { token: datos.token, expira: Date.now() + 5 * 60 * 60 * 1000 }; // 5 h (sesión real: 6 h)
  return sesionFP.token;
}

// Herramientas expuestas a Muse: solo lectura.
const HERRAMIENTAS = [
  {
    name: "obtener_resumen_finanzas",
    description: "Devuelve gastos, ingresos, deudas, proyectos e inversiones del usuario de Finanzas Pro.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    run: async () => llamarApi("obtenerDatos", {}, await obtenerToken()),
  },
  {
    name: "exportar_mis_datos",
    description: "Exporta todos los datos personales del usuario en JSON (derecho de portabilidad).",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    run: async () => llamarApi("exportarMisDatos", {}, await obtenerToken()),
  },
];

function respuestaRPC(id, result) { return { jsonrpc: "2.0", id, result }; }
function errorRPC(id, code, message) { return { jsonrpc: "2.0", id, error: { code, message } }; }

async function manejarMensaje(msg) {
  const { id, method, params } = msg;
  switch (method) {
    case "initialize":
      return respuestaRPC(id, {
        protocolVersion: params?.protocolVersion || "2025-06-18",
        capabilities: { tools: {} },
        serverInfo: { name: "finanzas-pro", version: "1.0.0" },
      });
    case "notifications/initialized":
      return null;
    case "tools/list":
      return respuestaRPC(id, {
        tools: HERRAMIENTAS.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })),
      });
    case "tools/call": {
      const h = HERRAMIENTAS.find(t => t.name === params?.name);
      if (!h) return errorRPC(id, -32602, "Herramienta no disponible");
      try {
        const datos = await h.run(params?.arguments || {});
        return respuestaRPC(id, { content: [{ type: "text", text: JSON.stringify(datos) }] });
      } catch (e) {
        // Mensaje genérico: no se devuelven detalles internos ni datos financieros.
        return respuestaRPC(id, { isError: true, content: [{ type: "text", text: "No se pudo completar la consulta." }] });
      }
    }
    default:
      return errorRPC(id ?? null, -32601, "Método no soportado");
  }
}

const servidor = http.createServer(async (req, res) => {
  if (req.method !== "POST" || req.url !== "/mcp") {
    res.writeHead(404).end();
    return;
  }
  if (req.headers.authorization !== `Bearer ${MCP_TOKEN}`) {
    res.writeHead(401).end();
    return;
  }
  let cuerpo = "";
  for await (const chunk of req) {
    cuerpo += chunk;
    if (cuerpo.length > 100_000) { res.writeHead(413).end(); return; }
  }
  try {
    const msg = JSON.parse(cuerpo);
    const salida = await manejarMensaje(msg);
    if (salida === null) { res.writeHead(202).end(); return; }
    res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify(salida));
  } catch {
    res.writeHead(400).end(JSON.stringify(errorRPC(null, -32700, "JSON inválido")));
  }
});

servidor.listen(PORT, () => console.log(`MCP Finanzas Pro escuchando en :${PORT}/mcp`));
