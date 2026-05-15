# TUNX Elo Viewer

Calculador de cambios de Elo FIDE para torneos de ajedrez.

## Funcionalidades
- 📂 Carga archivos `.TUNX` directamente desde Chess-Results
- 🌍 Filtra por país / federación
- 📊 Cálculo correcto: ΔRating = K × Σ(resultado − expected)
- 📱 Responsive (funciona en móvil)
- ♟ Datos del XV Panamericano U7-U17 2026 precargados

## Deploy en Vercel

### Opción 1 — Vercel CLI
```bash
npm i -g vercel
cd elo-viewer
vercel --prod
```

### Opción 2 — GitHub + Vercel
1. Crea un repo en GitHub y sube esta carpeta
2. Ve a vercel.com → New Project → importa el repo
3. Framework: Other → Deploy

## Uso
1. Abre la web
2. Descarga el `.TUNX` desde Chess-Results → Swiss-Manager tournament file
3. Arrástralo a la zona de carga
4. Filtra por CRC (u otro país)
5. Haz clic en cada jugador para ver sus partidas e impacto por ronda
