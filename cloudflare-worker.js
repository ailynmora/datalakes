const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*", // en producción real, pon tu dominio exacto en vez de "*"
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

export default {
  async fetch(request) {
    // El navegador manda una petición OPTIONS "de prueba" antes de la real,
    // preguntando si tiene permiso — hay que contestarle eso primero.
    if (request.method === "OPTIONS") {
      return new Response(null, { headers: CORS_HEADERS });
    }

    const url = new URL(request.url);

    // workers.dev/api/v1/trolebus  ->  simulacion.viccoding.dev/api/v1/trolebus
    const target = "https://simulacion.viccoding.dev" + url.pathname + url.search;

    const init = {
      method: request.method,
      headers: request.headers,
      body: ["GET", "HEAD"].includes(request.method)
        ? undefined
        : await request.clone().arrayBuffer(),
    };

    const respuesta = await fetch(target, init);

    // Igual que antes, pero ahora sí agregamos los headers de CORS —
    // porque esta vez el navegador SÍ ve que es un origen distinto.
    const headers = new Headers(respuesta.headers);
    Object.entries(CORS_HEADERS).forEach(([k, v]) => headers.set(k, v));

    return new Response(respuesta.body, {
      status: respuesta.status,
      headers,
    });
  },
};
