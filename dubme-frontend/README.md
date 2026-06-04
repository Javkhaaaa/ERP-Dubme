# dubme-frontend

dubme.mn-ийн web UI (Next.js 14 + TypeScript).

## Эхлүүлэх

```bash
# 1. Dependencies
yarn install

# 2. Env
cp .env.example .env.local
# → NEXT_PUBLIC_API_URL зөв заасан эсэхийг шалгах

# 3. Dev сервер
yarn dev
# → http://localhost:3000
```

## Ажиллах нөхцөл

- Node.js 20+
- **dubme-backend** аль хэдийн http://localhost:3001 дээр ажиллаж байх ёстой.

## Production

```bash
yarn build
yarn start
```

## Backend холбох

`.env.local`-д:
```
NEXT_PUBLIC_API_URL=http://localhost:3001     # local dev
NEXT_PUBLIC_API_URL=https://api.dubme.mn      # production
```
