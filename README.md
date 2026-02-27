# Xiaomi Mi Light Controller (Node.js)

REST API для управления умными лампочками и лентами Xiaomi/Yeelight:
- `on/off/toggle`
- `brightness`
- `temperature`
- `color`
- управление группами устройств

Проект сделан в стиле `mi-home-api` (`/api/v1/light/...`), но с фокусом только на свет.

## Что используется

- [`miio`](https://github.com/aholstenson/miio) для LAN-управления по miIO
- [`node-mihome`](https://github.com/maxinminax/node-mihome) для cloud-вызовов (`miCloudProtocol.miioCall`)
- Команды света (`set_power`, `set_bright`, `set_ct_abx`, `set_rgb`) совместимы с Yeelight/miIO

## Быстрый старт

```bash
npm install
cp config/lights.example.json config/lights.json
npm start
```

Сервер запустится на `http://localhost:3000` (или порт из `config/lights.json`).
Таймаут ответа API на одно устройство задается `requestTimeoutMs` (по умолчанию `12000` мс).

## Конфиг

Файл: `config/lights.json`

Пример уже есть в [`config/lights.example.json`](./config/lights.example.json).

### Типы транспорта

1. `lan`
Требуются:
- `address`
- `token`
- `model` (желательно)

2. `cloud`
Требуются:
- у устройства: `id`
- в секции `cloud`: `enabled=true`, `username`, `password`, `country`
- опционально:
  - `interactiveAuth` (`false` по умолчанию) — разрешить ввод капчи/2FA в терминале из процесса API
  - `sessionFile` (по умолчанию `config/.mi-cloud-session.json`) — кеш cloud-сессии, чтобы не проходить капчу каждый запуск
  - `captchaImagePath` (по умолчанию `xiaomi-captcha.jpg` в корне проекта)

### Cloud login (капча/2FA)

Если Xiaomi запрашивает дополнительную проверку, сервер сам попросит в терминале:
- ввести капчу (картинка сохранится в `captchaImagePath`)
- ввести email-код Xiaomi (если включена 2FA)

После успешного входа сессия сохранится в `sessionFile`, и последующие запуски обычно обходятся без капчи.
Если `interactiveAuth=false`, API не будет зависать в ожидании ввода: вернет ошибку с подсказкой включить интерактивный режим один раз.

`mijia.light.group*` (виртуальные cloud-группы) в API Xiaomi часто принимают команду без фактического изменения света.
Поэтому в этом сервисе для них управление выключено: используйте обычные локальные группы из `groups` (например `bedroom`).

## Примеры API

1. Статус всех ламп
```bash
curl http://localhost:3000/api/v1/light/status
```

2. Включить группу `living_room`
```bash
curl -X POST http://localhost:3000/api/v1/light/on/living_room
```

3. Яркость 35% для лампы `bedroom_ceiling`
```bash
curl -X POST http://localhost:3000/api/v1/light/brightness/bedroom_ceiling \
  -H "Content-Type: application/json" \
  -d '{"value":35,"duration":400}'
```

4. Цвет `#FF6600` для группы
```bash
curl -X POST http://localhost:3000/api/v1/light/color/living_room \
  -H "Content-Type: application/json" \
  -d '{"color":"#FF6600","duration":500}'
```

5. Цветовая температура 3200K
```bash
curl -X POST http://localhost:3000/api/v1/light/temperature/living_room \
  -H "Content-Type: application/json" \
  -d '{"value":3200}'
```

6. Комбинированное состояние
```bash
curl -X POST http://localhost:3000/api/v1/light/state/living_room \
  -H "Content-Type: application/json" \
  -d '{"power":"on","brightness":40,"temperature":3000,"duration":600}'
```

## Endpoints

- `GET /api/v1/light/status/:target?`
- `POST /api/v1/light/on/:target?`
- `POST /api/v1/light/off/:target?`
- `POST /api/v1/light/toggle/:target?`
- `POST /api/v1/light/brightness/:target?` body: `{ "value": 0..100, "duration"?: number }`
- `POST /api/v1/light/temperature/:target?` body: `{ "value": 1700..6500, "duration"?: number }`
- `POST /api/v1/light/color/:target?` body: `{ "color": "#RRGGBB" | { "r":0..255,"g":0..255,"b":0..255 } | [r,g,b], "duration"?: number }`
- `POST /api/v1/light/state/:target?` body: `{ "power"?, "brightness"?, "temperature"?, "color"?, "duration"? }`
- `GET /api/v1/groups`
- `GET /healthz`

`target` может быть:
- имя устройства
- имя группы
- пусто (тогда применяется ко всем устройствам)

## Практические заметки

- Для Aqara/Gateway LAN-настройки полезны материалы Domoticz wiki и LAN API (порт `9898`).
- Для miIO транспорт основан на документации бинарного протокола OpenMiHome (UDP `54321`).
- В Xiaomi Passport docs scope `6000` относится к smart-home сервисам (актуально для официальных OAuth-интеграций).

## Источники

- [victorwads/mi-home-api](https://github.com/victorwads/mi-home-api)
- [OpenMiHome/mihome-binary-protocol](https://github.com/OpenMiHome/mihome-binary-protocol)
- [Xiaomi Gateway (Aqara) - Domoticz](https://wiki.domoticz.com/Xiaomi_Gateway_%28Aqara%29)
- [Xiaomi Passport Scopes](https://dev.mi.com/docs/passport/en/scopes/)
- [Xiaomi Passport Open API](https://dev.mi.com/docs/passport/en/open-api/)
- [Xiaomi Passport SDK](https://dev.mi.com/docs/passport/en/sdk/)
- [xiaomi-passport org](https://github.com/orgs/xiaomi-passport/repositories)
- [mykhailog/mi-home](https://github.com/mykhailog/mi-home)
