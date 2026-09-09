import openpyxl, json, sys
wb = openpyxl.load_workbook(sys.argv[1], data_only=True)
ws = wb["RESPUESTAS"]
rows = list(ws.iter_rows(values_only=True))
hdr = [str(h).strip() if h else "" for h in rows[0]]
out = []
def hhmm(v):
    if v is None: return None
    s = str(v)
    if " " in s: s = s.split(" ")[1]
    p = s.split(":")
    return f"{int(p[0]):02d}:{int(p[1]):02d}" if len(p) >= 2 else None
for r in rows[1:]:
    if not any(r): continue
    d = dict(zip(hdr, r))
    fecha = d.get("FECHA")
    out.append({
        "nombre": (d.get("NOMBRE Y APELLIDO") or "").strip(),
        "fecha": str(fecha).split(" ")[0] if fecha else None,
        "presentacion": hhmm(d.get("HORA DE PRESENTACIÓN")),
        "llegada": hhmm(d.get("HORA DE LLEGADA")),
        "vuelo": (str(d.get("VUELO DE LLEGADA")).replace(".0", "").strip() if d.get("VUELO DE LLEGADA") is not None else ""),
        "reserva": (d.get("¿ES UNA RESERVA?") or "").strip().upper() == "SI",
        "pernocta": (d.get("¿ES UNA PERNOCTA?") or "").strip().upper() == "SI",
    })
json.dump(out, open(sys.argv[2], "w"), ensure_ascii=False, indent=1)
print(f"{len(out)} filas → {sys.argv[2]}")
