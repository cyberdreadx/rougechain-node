server {
  listen 80;
  server_name testnet.rougechain.io;
  return 301 https://$host$request_uri;
}

server {
  listen 443 ssl;
  server_name testnet.rougechain.io;

  ssl_certificate /etc/letsencrypt/live/testnet.rougechain.io/fullchain.pem;
  ssl_certificate_key /etc/letsencrypt/live/testnet.rougechain.io/privkey.pem;
  include /etc/letsencrypt/options-ssl-nginx.conf;
  ssl_dhparam /etc/letsencrypt/ssl-dhparams.pem;

  # WebSocket proxy — maps /ws to /api/ws
  location /ws {
    proxy_pass http://127.0.0.1:5101/api/ws;
    proxy_http_version 1.1;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "upgrade";
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_read_timeout 86400;
    proxy_send_timeout 86400;
  }

 # WebSocket endpoint for real-time updates
  location /api/ws {
    proxy_pass http://127.0.0.1:5101/api/ws;
    proxy_http_version 1.1;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "upgrade";
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_read_timeout 86400;
    proxy_send_timeout 86400;
  }

  location /api/ {
    proxy_hide_header Access-Control-Allow-Origin;
    add_header Access-Control-Allow-Origin "*" always;
    add_header Access-Control-Allow-Methods "GET, POST, PUT, DELETE, PATCH, OPTIONS" always;
    add_header Access-Control-Allow-Headers "Content-Type, Authorization, X-API-Key" always;
    add_header Access-Control-Max-Age 86400 always;
    proxy_pass http://127.0.0.1:5101;
    proxy_http_version 1.1;

    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;

    if ($request_method = OPTIONS) { return 204; }
  }

  location / {
    return 404;
  }
}
