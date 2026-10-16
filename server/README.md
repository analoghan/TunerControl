# TunerControl Server

Optional backend that serves the TunerControl web app and stores the M1 Config Viewer's tune history in a
SQLite database, so every browser sees the same history and the data can be queried with SQL.

- No npm dependencies — Node's built-in HTTP server and `node:sqlite`.
- Uploaded `.m1pkg` files are parsed on the server (`lib/m1pkg-parser.js`) and the original file is kept, so
  stored tunes are re-parsed automatically when the parser improves.
- When the M1 Config Viewer is opened from this server it uses the server; opened any other way (GitHub
  Pages, a local file) it falls back to browser storage as before.

**Requires Node.js 22.13 or newer** (Node 24 LTS recommended). Check with `node --version`.

## Configuration

| Variable | Default | Purpose |
|---|---|---|
| `PORT` | `8080` | Listen port |
| `HOST` | `127.0.0.1` | Listen address. Keep the default behind a reverse proxy; `0.0.0.0` accepts LAN connections directly |
| `TUNERCONTROL_DB` | `<repo>/data/tunercontrol.db` | SQLite database file |
| `TUNERCONTROL_TOKEN` | *(unset)* | When set, every API call needs it. The page asks for it once per browser |

Set `TUNERCONTROL_TOKEN` to a long random value (`openssl rand -hex 24`) whenever anything other than
the server itself can reach the port. Without it, anyone who can reach the server can read and change
tune data.

## Option A — systemd

```bash
# Node 24 (example for Debian/Ubuntu; any Node >= 22.13 works)
curl -fsSL https://deb.nodesource.com/setup_24.x | sudo -E bash -
sudo apt-get install -y nodejs

# App + service user
sudo git clone https://github.com/analoghan/TunerControl.git /opt/tunercontrol
sudo useradd --system --home /var/lib/tunercontrol --shell /usr/sbin/nologin tunercontrol

# Token (and any overrides such as HOST/PORT)
echo "TUNERCONTROL_TOKEN=$(openssl rand -hex 24)" | sudo tee /etc/tunercontrol.env
sudo chmod 600 /etc/tunercontrol.env

sudo cp /opt/tunercontrol/deploy/tunercontrol.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now tunercontrol
journalctl -u tunercontrol -f
```

The database is created at `/var/lib/tunercontrol/tunercontrol.db`. The unit listens on `127.0.0.1:8080`;
put a reverse proxy in front for HTTPS (below) or add `HOST=0.0.0.0` to `/etc/tunercontrol.env` for plain
HTTP on a trusted LAN.

Update: `cd /opt/tunercontrol && sudo git pull && sudo systemctl restart tunercontrol`.

## Option B — Docker

```bash
git clone https://github.com/analoghan/TunerControl.git && cd TunerControl
docker build -t tunercontrol .
docker run -d --name tunercontrol --restart unless-stopped \
  -p 127.0.0.1:8080:8080 -v tunercontrol-data:/data \
  -e TUNERCONTROL_TOKEN=$(openssl rand -hex 24) tunercontrol
docker logs tunercontrol          # shows the listening address
```

Drop the `127.0.0.1:` prefix on `-p` to expose the port on the LAN instead of only to a local proxy.
Update by pulling, rebuilding and re-creating the container; the `tunercontrol-data` volume keeps the database.

## HTTPS with a reverse proxy

Caddy obtains certificates automatically. `/etc/caddy/Caddyfile`:

```
tune.example.com {
    reverse_proxy 127.0.0.1:8080
}
```

Then open `https://tune.example.com/m1-config/`. Raise any upload limit on the proxy to at least 64 MB if
your proxy has one (Caddy has none by default; nginx needs `client_max_body_size 64m;`).

## Moving tunes from browser storage

1. Open the M1 Config Viewer the way you used it before (it still reads browser storage) and click
   **Export backup**.
2. Open the viewer from the server and click **Restore backup** with that file. Pin names come across too.

Packages restored from a backup have no original file, so they are not re-parsed on parser updates —
re-import the `.m1pkg` files instead if you still have them.

## Backups

The database is one file. A consistent copy while the server runs:

```bash
sqlite3 /var/lib/tunercontrol/tunercontrol.db ".backup '/backups/tunercontrol-$(date +%F).db'"
```

`GET /api/backup` also returns a JSON backup (parsed data and pin names, without the original files).

## Querying the data

`cell_values` holds one row per value per tune — scalars (`cell_key` = `''`), axis sites (`X[i]`, `Y[i]`)
and table cells (`V[x,y]`). Values are in the units the package stores (deg/s, Pa, s, ratio…); the
viewer converts them to M1 Tune's display units.

```sql
-- How one fuel timing cell changed across every tune
SELECT tune_name, modified, value FROM cell_values
WHERE item_name = 'Fuel.Timing.Primary.Main' AND cell_key = 'V[4,3]' ORDER BY modified;

-- Every ignition item that differs between two tunes
SELECT a.item_name, a.cell_key, a.value AS before, b.value AS after
FROM cell_values a JOIN cell_values b USING (item_name, cell_key)
WHERE a.tune_name LIKE '%V54' AND b.tune_name LIKE '%V55'
  AND a.item_name LIKE 'Ignition.%' AND a.value IS NOT b.value;
```

The same history is available over HTTP: `GET /api/history?item=Fuel.Timing.Primary.Main&cell=V[4,3]`.
See the header of `server.js` for the full API.
