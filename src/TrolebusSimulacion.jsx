import React, { useState, useEffect, useRef, useCallback, useMemo } from "react";
import {
  LineChart,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  Legend,
  ReferenceLine,
  ResponsiveContainer,
} from "recharts";
import {
  Bus,
  Users,
  MapPin,
  Play,
  FastForward,
  Square,
  ShieldCheck,
  RefreshCw,
  AlertCircle,
  Gauge,
  Clock,
  Navigation,
  TrendingUp,
  Percent,
} from "lucide-react";

// ---------------------------------------------------------------------------
// Conexión real a la API de simulación (ver docs en
// https://simulacion.viccoding.dev/docs#/).
//
// Nota: "iniciar", "avance_rapido" y "detener" son POST porque cambian el
// estado de la simulación; "trolebus", "peatones" y "validar_simulacion" son
// GET porque solo leen datos. Si el Swagger indica otro verbo, solo hay que
// cambiar el `method` de la llamada correspondiente.
// ---------------------------------------------------------------------------

// Con "proxy": "https://simulacion.viccoding.dev" en package.json,
// esta ruta relativa la resuelve el servidor de desarrollo de CRA,
// no el navegador — así se evita el bloqueo de CORS.
const API_BASE = "/api/v1";
const POLL_MS = 5000;
const MAX_HISTORY = 400; // ~33 min a 5s por ciclo — suficiente para ver salidas escalonadas
const MOVING_AVG_WINDOW = 5; // cuántos puntos cercanos promedia el filtro de media móvil
const BUNCHING_THRESHOLD = 0.75; // umbral de "bunching" para el coeficiente de variación

const LINE_COLORS = ["#0D9488", "#D97706", "#6366F1", "#DB2777", "#2563EB", "#059669"];

async function apiPost(path) {
  console.log(`[API] → POST ${API_BASE}${path}`);
  try {
    const res = await fetch(`${API_BASE}${path}`, { method: "POST" });
    console.log(`[API] ← POST ${path} · HTTP ${res.status}`);
    if (!res.ok) {
      const texto = await res.text();
      console.error(`[API] ✗ POST ${path} falló:`, texto.slice(0, 300));
      throw new Error(`HTTP ${res.status} en ${path}`);
    }
    const data = await res.json();
    console.log(`[API] ✓ POST ${path} OK:`, data);
    return data;
  } catch (e) {
    console.error(`[API] ✗ POST ${path} — error de red o conexión:`, e);
    throw e;
  }
}

async function apiGet(path) {
  console.log(`[API] → GET ${API_BASE}${path}`);
  try {
    const res = await fetch(`${API_BASE}${path}`);
    console.log(`[API] ← GET ${path} · HTTP ${res.status}`);
    if (!res.ok) {
      const texto = await res.text();
      console.error(`[API] ✗ GET ${path} falló:`, texto.slice(0, 300));
      throw new Error(`HTTP ${res.status} en ${path}`);
    }
    const data = await res.json();
    console.log(`[API] ✓ GET ${path} OK:`, data);
    return data;
  } catch (e) {
    console.error(`[API] ✗ GET ${path} — error de red o conexión:`, e);
    throw e;
  }
}

function shortId(id) {
  // "f_trolebus_zacatenco.3" -> "Trolebús 3"
  const parts = id.split(".");
  return `Trolebús ${parts[parts.length - 1]}`;
}

function formatTimestamp(ts) {
  if (!ts) return "—";
  try {
    return new Date(ts).toLocaleTimeString("es-MX", { hour12: false });
  } catch {
    return ts;
  }
}

// Abrevia números grandes para que quepan en el eje Y sin amontonarse:
// 8624.19 -> "8.6 k", 15000 -> "15 k", 500 -> "500".
const abreviarDistancia = new Intl.NumberFormat("es-MX", {
  notation: "compact",
  maximumFractionDigits: 1,
});

// Versión completa con separador de miles, para el tooltip (ahí sí hay
// espacio de sobra y conviene ver el valor exacto, no abreviado).
const formatoDistanciaExacta = new Intl.NumberFormat("es-MX", {
  maximumFractionDigits: 1,
});

export default function TrolebusSimulacion() {
  const [trolebuses, setTrolebuses] = useState([]);
  const [metaTrolebus, setMetaTrolebus] = useState(null);
  const [paradas, setParadas] = useState([]);
  const [metaPeatones, setMetaPeatones] = useState(null);
  const [history, setHistory] = useState([]);
  const [velocidadHistory, setVelocidadHistory] = useState([]);
  const [simMsg, setSimMsg] = useState(null); // { texto, ok }
  const [loadingAction, setLoadingAction] = useState(null);
  const [fetchError, setFetchError] = useState(null);
  const [conexion, setConexion] = useState("pendiente"); // "ok" | "error" | "pendiente"
  const [ultimaConexionOk, setUltimaConexionOk] = useState(null);
  const [autoRefresh, setAutoRefresh] = useState(true);
  const [filtroFlota, setFiltroFlota] = useState("todos");
  const colorMap = useRef({});

  const assignColor = (id) => {
    if (!colorMap.current[id]) {
      const n = Object.keys(colorMap.current).length;
      colorMap.current[id] = LINE_COLORS[n % LINE_COLORS.length];
    }
    return colorMap.current[id];
  };

  const fetchAll = useCallback(async () => {
    console.log(`[fetchAll] iniciando ciclo de actualización — ${new Date().toLocaleTimeString("es-MX")}`);
    try {
      const [trolebusData, peatonesData] = await Promise.all([
        apiGet("/trolebus"),
        apiGet("/peatones"),
      ]);

      setTrolebuses(trolebusData.trolebuses ?? []);
      setMetaTrolebus(trolebusData.meta ?? null);
      setParadas(peatonesData.paradas ?? []);
      setMetaPeatones(peatonesData.meta ?? null);
      setFetchError(null);
      setConexion("ok");
      setUltimaConexionOk(new Date());
      console.log(
        `[fetchAll] ✓ ciclo completo — ${trolebusData.trolebuses?.length ?? 0} trolebuses, ${peatonesData.paradas?.length ?? 0} paradas`
      );

      if (trolebusData.meta) {
        setHistory((prev) => {
          const point = { step: trolebusData.meta.step };
          (trolebusData.trolebuses ?? []).forEach((t) => {
            point[t.trolebus_id] = t.distancia_recorrida;
            assignColor(t.trolebus_id);
          });
          const next = [...prev, point];
          return next.length > MAX_HISTORY ? next.slice(next.length - MAX_HISTORY) : next;
        });

        setVelocidadHistory((prev) => {
          const velocidades = (trolebusData.trolebuses ?? []).map((t) => t.velocidad_kmh);
          const media = velocidades.length
            ? velocidades.reduce((a, b) => a + b, 0) / velocidades.length
            : 0;
          const next = [...prev, { step: trolebusData.meta.step, velocidadMedia: +media.toFixed(2) }];
          return next.length > MAX_HISTORY ? next.slice(next.length - MAX_HISTORY) : next;
        });
      }
    } catch (e) {
      console.error("[fetchAll] ✗ ciclo falló:", e);
      setFetchError(e.message || "No se pudo conectar con la API.");
      setConexion("error");
    }
  }, []);

  useEffect(() => {
    fetchAll();
  }, [fetchAll]);

  useEffect(() => {
    if (!autoRefresh) return;
    const id = setInterval(fetchAll, POLL_MS);
    return () => clearInterval(id);
  }, [autoRefresh, fetchAll]);

  const runAction = async (key, fn, successLabel) => {
    setLoadingAction(key);
    setSimMsg(null);
    try {
      const data = await fn();
      setSimMsg({ texto: data.mensaje || successLabel, ok: data.estado === "ok" });
      if (key !== "validar") fetchAll();
    } catch (e) {
      setSimMsg({ texto: e.message || "La acción falló.", ok: false });
    } finally {
      setLoadingAction(null);
    }
  };

  const filteredTrolebuses = useMemo(() => {
    if (filtroFlota === "movimiento") return trolebuses.filter((t) => t.velocidad_kmh > 0);
    if (filtroFlota === "detenido") return trolebuses.filter((t) => t.velocidad_kmh === 0);
    return trolebuses;
  }, [trolebuses, filtroFlota]);

  const paradasOrdenadas = useMemo(
    () => [...paradas].sort((a, b) => b.personas_esperando - a.personas_esperando),
    [paradas]
  );

  // Gráfica 2: velocidad media del sistema (promedio de todos los
  // trolebuses activos) a lo largo del tiempo de simulación, más un
  // filtro de media móvil que suaviza el ruido y deja ver la tendencia.
  const velocidadConTendencia = useMemo(() => {
    return velocidadHistory.map((point, i, arr) => {
      const ventana = arr.slice(Math.max(0, i - MOVING_AVG_WINDOW + 1), i + 1);
      const mediaMovil =
        ventana.reduce((a, b) => a + b.velocidadMedia, 0) / ventana.length;
      return { ...point, mediaMovil: +mediaMovil.toFixed(2) };
    });
  }, [velocidadHistory]);

  const tendenciaVelocidad = useMemo(() => {
    if (velocidadConTendencia.length < 2) return null;
    const actual = velocidadConTendencia[velocidadConTendencia.length - 1].mediaMovil;
    const anterior = velocidadConTendencia[velocidadConTendencia.length - 2].mediaMovil;
    const diff = actual - anterior;
    if (Math.abs(diff) < 0.05) return "estable";
    return diff > 0 ? "al alza" : "a la baja";
  }, [velocidadConTendencia]);

  // Gráfica 3: coeficiente de variación (desviación estándar ÷ media,
  // como razón simple, no porcentaje) de la distancia recorrida entre
  // todos los trolebuses activos, calculado en cada paso ya guardado
  // en `history`. CV → 1 cuando la desviación iguala a la media
  // (mucha dispersión); CV → 0 cuando casi no hay dispersión.
  const coeficienteVariacion = useMemo(() => {
    return history.map((point) => {
      const valores = Object.keys(point)
        .filter((k) => k !== "step")
        .map((k) => point[k])
        .filter((v) => typeof v === "number");

      if (valores.length === 0) return { step: point.step, cv: null };

      const media = valores.reduce((a, b) => a + b, 0) / valores.length;
      const varianza = valores.reduce((a, b) => a + (b - media) ** 2, 0) / valores.length;
      const desviacion = Math.sqrt(varianza);
      const cv = media !== 0 ? desviacion / media : 0;

      return { step: point.step, cv: +cv.toFixed(3), media: +media.toFixed(1) };
    });
  }, [history]);

  const trolebusIds = trolebuses.map((t) => t.trolebus_id);


  return (
    <div
      style={{
        minHeight: "100%",
        background: "radial-gradient(circle at 15% 0%, #F6F7F9 0%, #EDEFF2 45%, #E4E7EB 100%)",
        color: "#1F2430",
        fontFamily: "'Inter', sans-serif",
        padding: "28px 24px 40px",
      }}
    >
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&family=JetBrains+Mono:wght@400;500;600;700&display=swap');
        .mono { font-family: 'JetBrains Mono', monospace; }
        .panel {
          background: linear-gradient(180deg, #FFFFFF, #FAFAFB);
          border: 1px solid rgba(31,36,48,0.08);
          border-radius: 12px;
          box-shadow: 0 1px 2px rgba(16,24,40,0.04), 0 1px 3px rgba(16,24,40,0.05);
        }
        .action-btn {
          display: flex; align-items: center; gap: 6px;
          padding: 9px 14px; border-radius: 8px; font-size: 12px; font-weight: 600;
          border: 1px solid rgba(31,36,48,0.12); background: #FFFFFF; cursor: pointer;
          transition: all 0.15s ease; color: #1F2430;
        }
        .action-btn:hover { transform: translateY(-1px); box-shadow: 0 4px 10px rgba(16,24,40,0.08); }
        .action-btn:disabled { opacity: 0.55; cursor: not-allowed; transform: none; box-shadow: none; }
        .truck-card { background: #FFFFFF; border: 1px solid rgba(31,36,48,0.08); border-radius: 8px; padding: 12px 14px; transition: box-shadow 0.2s ease, transform 0.15s ease; }
        .truck-card:hover { box-shadow: 0 4px 12px rgba(16,24,40,0.06); transform: translateY(-1px); }
        .filter-chip { transition: all 0.18s ease; cursor: pointer; }
        @keyframes spin { to { transform: rotate(360deg); } }
        .spin { animation: spin 0.9s linear infinite; }
        ::-webkit-scrollbar { width: 8px; height: 8px; }
        ::-webkit-scrollbar-thumb { background: rgba(31,36,48,0.18); border-radius: 4px; }
      `}</style>

      {/* Header */}
      <div
        style={{
          display: "flex", justifyContent: "space-between", alignItems: "flex-end", flexWrap: "wrap",
          gap: 16, marginBottom: 20, borderBottom: "1px solid rgba(31,36,48,0.1)", paddingBottom: 18,
        }}
      >
        <div>
          <div className="mono" style={{ color: "#0D9488", fontSize: 12, letterSpacing: 3, marginBottom: 6 }}>
            TROLEBÚS ZACATENCO · SMART CITIES
          </div>
          <h1 style={{ margin: 0, fontSize: 26, fontWeight: 700, letterSpacing: -0.5, color: "#111827" }}>
            Consola de Simulación
          </h1>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 18 }}>
          <div
            className="mono"
            style={{
              display: "flex", alignItems: "center", gap: 6, fontSize: 11,
              padding: "5px 10px", borderRadius: 20,
              color: conexion === "ok" ? "#0D9488" : conexion === "error" ? "#DB2777" : "#9AA3B2",
              background: conexion === "ok" ? "rgba(13,148,136,0.1)" : conexion === "error" ? "rgba(219,39,119,0.1)" : "rgba(154,163,178,0.1)",
            }}
          >
            <span
              style={{
                width: 7, height: 7, borderRadius: "50%",
                background: conexion === "ok" ? "#0D9488" : conexion === "error" ? "#DB2777" : "#9AA3B2",
                display: "inline-block",
              }}
            />
            {conexion === "ok" && `Conectado${ultimaConexionOk ? " · " + ultimaConexionOk.toLocaleTimeString("es-MX", { hour12: false }) : ""}`}
            {conexion === "error" && "Sin conexión"}
            {conexion === "pendiente" && "Conectando…"}
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 6, color: "#6B7280" }}>
            <Clock size={14} />
            <span className="mono" style={{ fontSize: 13 }}>
              step {metaTrolebus?.step ?? "—"} · {formatTimestamp(metaTrolebus?.timestamp)}
            </span>
          </div>
          <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 12, color: "#6B7280", cursor: "pointer" }}>
            <input type="checkbox" checked={autoRefresh} onChange={(e) => setAutoRefresh(e.target.checked)} />
            auto-refresh {POLL_MS / 1000}s
          </label>
          <button className="action-btn" onClick={fetchAll} title="Actualizar ahora">
            <RefreshCw size={13} /> Actualizar
          </button>
        </div>
      </div>

      {fetchError && (
        <div style={{ display: "flex", alignItems: "center", gap: 8, background: "#FEF2F2", border: "1px solid #FECACA", color: "#B91C1C", borderRadius: 8, padding: "10px 14px", marginBottom: 16, fontSize: 12 }}>
          <AlertCircle size={14} />
          {fetchError} — revisa que la simulación esté corriendo o que la API permita peticiones desde este origen (CORS).
        </div>
      )}

      {/* Panel de control de simulación */}
      <div className="panel" style={{ padding: 18, marginBottom: 18 }}>
        <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: 10 }}>
          <button className="action-btn" disabled={loadingAction === "iniciar"} onClick={() => runAction("iniciar", () => apiPost("/simulacion/iniciar"), "Simulación iniciada")}>
            {loadingAction === "iniciar" ? <RefreshCw size={13} className="spin" /> : <Play size={13} color="#0D9488" />}
            Iniciar
          </button>
          <button className="action-btn" disabled={loadingAction === "avance"} onClick={() => runAction("avance", () => apiPost("/simulacion/avance_rapido"), "Avance aplicado")}>
            {loadingAction === "avance" ? <RefreshCw size={13} className="spin" /> : <FastForward size={13} color="#D97706" />}
            Avance rápido
          </button>
          <button className="action-btn" disabled={loadingAction === "validar"} onClick={() => runAction("validar", () => apiGet("/simulacion/validar_simulacion"), "Estado verificado")}>
            {loadingAction === "validar" ? <RefreshCw size={13} className="spin" /> : <ShieldCheck size={13} color="#6366F1" />}
            Validar estado
          </button>
          <button className="action-btn" disabled={loadingAction === "detener"} onClick={() => runAction("detener", () => apiPost("/simulacion/detener"), "Simulación detenida")}>
            {loadingAction === "detener" ? <RefreshCw size={13} className="spin" /> : <Square size={13} color="#DB2777" />}
            Detener
          </button>

          {simMsg && (
            <span
              className="mono"
              style={{
                fontSize: 12, padding: "6px 12px", borderRadius: 20,
                background: simMsg.ok ? "rgba(13,148,136,0.1)" : "rgba(219,39,119,0.1)",
                color: simMsg.ok ? "#0D9488" : "#DB2777",
              }}
            >
              {simMsg.texto}
            </span>
          )}
        </div>
      </div>

      {/* Grid: flota + paradas */}
      <div style={{ display: "grid", gridTemplateColumns: "1.3fr 1fr", gap: 18, marginBottom: 18 }}>
        {/* Flota */}
        <div className="panel" style={{ padding: 20 }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", flexWrap: "wrap", gap: 10 }}>
            <PanelHeader icon={<Bus size={16} />} eyebrow={`FLOTA · ${trolebuses.length} trolebuses`} title="Trolebuses en tránsito" accent="#D97706" />
            <div style={{ display: "flex", gap: 6 }}>
              {[
                { key: "todos", label: "Todos" },
                { key: "movimiento", label: "En movimiento" },
                { key: "detenido", label: "Detenidos" },
              ].map((f) => (
                <button
                  key={f.key}
                  className="filter-chip mono"
                  onClick={() => setFiltroFlota(f.key)}
                  style={{
                    fontSize: 10, padding: "5px 9px", borderRadius: 20,
                    background: filtroFlota === f.key ? "rgba(217,119,6,0.12)" : "transparent",
                    border: `1px solid ${filtroFlota === f.key ? "#D97706" : "rgba(31,36,48,0.14)"}`,
                    color: filtroFlota === f.key ? "#D97706" : "#6B7280",
                  }}
                >
                  {f.label}
                </button>
              ))}
            </div>
          </div>

          <div style={{ marginTop: 14, display: "flex", flexDirection: "column", gap: 10, overflowY: "auto", maxHeight: 480 }}>
            {filteredTrolebuses.map((t) => {
              const enMovimiento = t.velocidad_kmh > 0;
              return (
                <div key={t.trolebus_id} className="truck-card">
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: 6 }}>
                    <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                      <span className="mono" style={{ fontSize: 13, fontWeight: 700, color: assignColor(t.trolebus_id) }}>
                        {shortId(t.trolebus_id)}
                      </span>
                      <span
                        className="mono"
                        style={{
                          fontSize: 9, padding: "2px 7px", borderRadius: 20, letterSpacing: 0.5,
                          color: enMovimiento ? "#0D9488" : "#DB2777",
                          background: enMovimiento ? "rgba(13,148,136,0.1)" : "rgba(219,39,119,0.1)",
                        }}
                      >
                        {enMovimiento ? "EN MOVIMIENTO" : "DETENIDO"}
                      </span>
                    </div>
                    <div style={{ display: "flex", alignItems: "center", gap: 5, color: "#6B7280" }}>
                      <Users size={12} />
                      <span className="mono" style={{ fontSize: 12 }}>{t.pasajeros_a_bordo}</span>
                    </div>
                  </div>

                  <div style={{ display: "flex", alignItems: "center", gap: 6, marginTop: 8, fontSize: 12, color: "#4B5563" }}>
                    <MapPin size={12} color="#0D9488" />
                    <span>Próxima: {t.proxima_estacion}</span>
                  </div>

                  <div style={{ display: "flex", flexWrap: "wrap", gap: 14, marginTop: 8 }}>
                    <div style={{ display: "flex", alignItems: "center", gap: 5, color: "#6B7280" }}>
                      <Gauge size={12} />
                      <span className="mono" style={{ fontSize: 11 }}>{t.velocidad_kmh} km/h</span>
                    </div>
                    <div style={{ display: "flex", alignItems: "center", gap: 5, color: "#6B7280" }}>
                      <Navigation size={12} />
                      <span className="mono" style={{ fontSize: 11 }}>{t.distancia_recorrida.toFixed(1)} m recorridos</span>
                    </div>
                  </div>

                  <div className="mono" style={{ fontSize: 10, color: "#9AA3B2", marginTop: 6 }}>
                    lat {t.localizacion.latitud.toFixed(5)}, lon {t.localizacion.longitud.toFixed(5)}
                  </div>
                </div>
              );
            })}
            {filteredTrolebuses.length === 0 && (
              <div style={{ textAlign: "center", padding: "24px 0", color: "#9AA3B2", fontSize: 12 }}>
                Sin datos de trolebuses todavía.
              </div>
            )}
          </div>
        </div>

        {/* Paradas / peatones */}
        <div className="panel" style={{ padding: 20 }}>
          <PanelHeader icon={<Users size={16} />} eyebrow={`PARADAS · ${paradas.length}`} title="Peatones esperando" accent="#6366F1" />
          <div style={{ marginTop: 14, display: "flex", flexDirection: "column", gap: 6, overflowY: "auto", maxHeight: 480 }}>
            {paradasOrdenadas.map((p) => (
              <div
                key={p.parada_id}
                style={{
                  display: "flex", justifyContent: "space-between", alignItems: "center",
                  padding: "7px 10px", borderRadius: 6,
                  background: p.personas_esperando > 0 ? "rgba(99,102,241,0.06)" : "transparent",
                }}
              >
                <span style={{ fontSize: 12, color: "#374151" }}>{p.nombre_parada}</span>
                <span
                  className="mono"
                  style={{
                    fontSize: 11, fontWeight: 700,
                    color: p.personas_esperando > 0 ? "#6366F1" : "#B7BEC9",
                  }}
                >
                  {p.personas_esperando}
                </span>
              </div>
            ))}
          </div>
        </div>
      </div>

      {/* Gráfica 1 — Distancia recorrida vs. tiempo, por trolebús */}
      <div className="panel" style={{ padding: 20, marginBottom: 18 }}>
        <PanelHeader icon={<Navigation size={16} />} eyebrow="MÉTRICA 1" title="Distancia recorrida vs. tiempo" accent="#6366F1" />
        <p style={{ fontSize: 11, color: "#9AA3B2", margin: "4px 0 0" }}>
          Rango completo desde 0 m — así se ve en qué momento (eje X) empieza a moverse cada trolebús, para comparar sus horarios de salida.
        </p>
        <div style={{ height: 380, marginTop: 12 }}>
          <ResponsiveContainer width="100%" height="100%">
            <LineChart data={history} margin={{ top: 10, right: 20, left: 0, bottom: 10 }}>
              <CartesianGrid stroke="rgba(31,36,48,0.08)" />
              <XAxis
                dataKey="step"
                type="number"
                domain={["dataMin", "dataMax"]}
                tick={{ fontSize: 11, fill: "#6B7280" }}
                label={{ value: "Tiempo de simulación (s)", position: "insideBottom", offset: -4, fontSize: 11, fill: "#6B7280" }}
              />
              <YAxis
                domain={[0, "dataMax"]}
                tick={{ fontSize: 11, fill: "#6B7280" }}
                tickFormatter={(v) => abreviarDistancia.format(v)}
                label={{ value: "Distancia recorrida (m)", angle: -90, position: "insideLeft", fontSize: 11, fill: "#6B7280" }}
              />
              <Tooltip
                contentStyle={{ background: "#FFFFFF", border: "1px solid rgba(31,36,48,0.1)", borderRadius: 8, fontSize: 12 }}
                labelFormatter={(v) => `t = ${v}s`}
                formatter={(value, name) => [`${formatoDistanciaExacta.format(value)} m`, shortId(name)]}
              />
              <Legend wrapperStyle={{ fontSize: 11 }} formatter={(value) => shortId(value)} />
              {trolebusIds.map((id) => (
                <Line
                  key={id}
                  type="linear"
                  dataKey={id}
                  stroke={assignColor(id)}
                  strokeWidth={2}
                  dot={false}
                  connectNulls={false}
                  isAnimationActive={false}
                />
              ))}
            </LineChart>
          </ResponsiveContainer>
        </div>
        {history.length < 2 && (
          <p style={{ fontSize: 11, color: "#9AA3B2", marginTop: 8 }}>
            La gráfica se va llenando conforme pasan los ciclos de actualización — deja correr la simulación unos minutos para ver las salidas escalonadas.
          </p>
        )}
      </div>

      {/* Gráfica 2 — Velocidad media del sistema vs. tiempo, con media móvil */}
      <div className="panel" style={{ padding: 20, marginBottom: 18 }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", flexWrap: "wrap", gap: 10 }}>
          <PanelHeader icon={<TrendingUp size={16} />} eyebrow="MÉTRICA 2" title="Velocidad media del sistema vs. tiempo" accent="#0D9488" />
          {tendenciaVelocidad && (
            <span
              className="mono"
              style={{
                fontSize: 11, padding: "5px 12px", borderRadius: 20,
                color: tendenciaVelocidad === "al alza" ? "#0D9488" : tendenciaVelocidad === "a la baja" ? "#DB2777" : "#6B7280",
                background: tendenciaVelocidad === "al alza" ? "rgba(13,148,136,0.1)" : tendenciaVelocidad === "a la baja" ? "rgba(219,39,119,0.1)" : "rgba(107,114,128,0.1)",
              }}
            >
              Tendencia: {tendenciaVelocidad}
            </span>
          )}
        </div>
        <p style={{ fontSize: 11, color: "#9AA3B2", margin: "4px 0 0" }}>
          Línea clara = velocidad media cruda de cada ciclo. Línea sólida = media móvil de los últimos {MOVING_AVG_WINDOW} ciclos, que suaviza el ruido para ver la tendencia real.
        </p>
        <div style={{ height: 280, marginTop: 12 }}>
          <ResponsiveContainer width="100%" height="100%">
            <LineChart data={velocidadConTendencia} margin={{ top: 10, right: 20, left: 0, bottom: 10 }}>
              <CartesianGrid stroke="rgba(31,36,48,0.08)" />
              <XAxis
                dataKey="step"
                type="number"
                domain={["dataMin", "dataMax"]}
                tick={{ fontSize: 11, fill: "#6B7280" }}
                label={{ value: "Tiempo de simulación (s)", position: "insideBottom", offset: -4, fontSize: 11, fill: "#6B7280" }}
              />
              <YAxis
                tick={{ fontSize: 11, fill: "#6B7280" }}
                label={{ value: "Velocidad media (km/h)", angle: -90, position: "insideLeft", fontSize: 11, fill: "#6B7280" }}
              />
              <Tooltip
                contentStyle={{ background: "#FFFFFF", border: "1px solid rgba(31,36,48,0.1)", borderRadius: 8, fontSize: 12 }}
                labelFormatter={(v) => `t = ${v}s`}
                formatter={(value, name) => [`${value} km/h`, name === "velocidadMedia" ? "Cruda" : "Media móvil"]}
              />
              <Legend wrapperStyle={{ fontSize: 11 }} formatter={(v) => (v === "velocidadMedia" ? "Cruda" : "Media móvil")} />
              <Line type="monotone" dataKey="velocidadMedia" stroke="#0D9488" strokeOpacity={0.35} strokeWidth={1.5} dot={false} isAnimationActive={false} />
              <Line type="monotone" dataKey="mediaMovil" stroke="#0D9488" strokeWidth={2.5} dot={false} isAnimationActive={false} />
            </LineChart>
          </ResponsiveContainer>
        </div>
        {velocidadConTendencia.length === 0 && (
          <p style={{ fontSize: 11, color: "#9AA3B2", marginTop: 8 }}>Esperando datos de trolebuses.</p>
        )}
      </div>

      {/* Gráfica 3 — Coeficiente de variación de la distancia recorrida */}
      <div className="panel" style={{ padding: 20 }}>
        <PanelHeader icon={<Percent size={16} />} eyebrow="MÉTRICA 3" title="Coeficiente de variación · distancia recorrida" accent="#D97706" />
        <p style={{ fontSize: 11, color: "#9AA3B2", margin: "4px 0 0" }}>
          CV = desviación estándar ÷ media (razón, no porcentaje). Tiende a 1 cuando la desviación iguala a la media (mucha dispersión entre trolebuses); tiende a 0 cuando casi no hay dispersión. La línea punteada marca el umbral de bunching en {BUNCHING_THRESHOLD}.
        </p>
        <div style={{ height: 280, marginTop: 12 }}>
          <ResponsiveContainer width="100%" height="100%">
            <LineChart data={coeficienteVariacion} margin={{ top: 10, right: 20, left: 0, bottom: 10 }}>
              <CartesianGrid stroke="rgba(31,36,48,0.08)" />
              <XAxis
                dataKey="step"
                type="number"
                domain={["dataMin", "dataMax"]}
                tick={{ fontSize: 11, fill: "#6B7280" }}
                label={{ value: "Tiempo de simulación (s)", position: "insideBottom", offset: -4, fontSize: 11, fill: "#6B7280" }}
              />
              <YAxis
                domain={[0, 1.5]}
                tick={{ fontSize: 11, fill: "#6B7280" }}
                label={{ value: "Coeficiente de variación (σ/μ)", angle: -90, position: "insideLeft", fontSize: 11, fill: "#6B7280" }}
              />
              <Tooltip
                contentStyle={{ background: "#FFFFFF", border: "1px solid rgba(31,36,48,0.1)", borderRadius: 8, fontSize: 12 }}
                formatter={(value, name) => (name === "cv" ? [value, "CV"] : [value, name])}
                labelFormatter={(v) => `t = ${v}s`}
              />
              <ReferenceLine
                y={BUNCHING_THRESHOLD}
                stroke="#DB2777"
                strokeDasharray="5 4"
                label={{ value: `Umbral de bunching (${BUNCHING_THRESHOLD})`, position: "insideTopRight", fontSize: 10, fill: "#DB2777" }}
              />
              <Line type="monotone" dataKey="cv" stroke="#D97706" strokeWidth={2} dot={false} connectNulls isAnimationActive={false} />
            </LineChart>
          </ResponsiveContainer>
        </div>
        {coeficienteVariacion.length < 2 && (
          <p style={{ fontSize: 11, color: "#9AA3B2", marginTop: 8 }}>
            Se necesitan al menos un par de ciclos de actualización para dibujar esta gráfica — deja correr la simulación unos segundos.
          </p>
        )}
      </div>
    </div>
  );
}

function PanelHeader({ icon, eyebrow, title, accent }) {
  return (
    <div>
      <div className="mono" style={{ display: "flex", alignItems: "center", gap: 6, color: accent, fontSize: 11, letterSpacing: 1.5, marginBottom: 6 }}>
        {icon}
        <span>{eyebrow}</span>
      </div>
      <h2 style={{ margin: 0, fontSize: 17, fontWeight: 600, color: "#111827" }}>{title}</h2>
    </div>
  );
}