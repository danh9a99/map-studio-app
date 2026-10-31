# Map Studio

App desktop (macOS, Windows) vẽ đường, tên đường, khu vực và làm nổi toà nhà bám theo clip flycam.

## Cấu trúc

| Thư mục | Nội dung |
|---|---|
| `src/` | Lớp bản đồ trên video (Remotion): `mapshot/`, `MapRoot.tsx`, `map-index.ts` |
| `web/` | Trình chỉnh sửa (React) và API bản đồ |
| `scripts/` | Python: cắt clip, bám chuyển động, khớp bản đồ, chỉnh màu, SAM 2 |
| `desktop/` | Electron: server cục bộ, cài đặt lần đầu, trình dựng hình, cấu hình đóng gói |

## Chạy khi phát triển

```bash
npm install
```

```bash
npm install --prefix desktop && npm install --prefix desktop/app
```

```bash
npm run dev --prefix desktop
```

Mở địa chỉ được in ra (mặc định http://localhost:4330). Dữ liệu thử nằm trong `desktop/.dev-data`.

Cần có `uv` trên máy (https://docs.astral.sh/uv/). App dùng nó để tải Python cho người dùng.

## Đóng gói

```bash
npm run dist --prefix desktop
```

File cài đặt nằm trong `desktop/release/`. Bản macOS mới ký tạm (chưa có tài khoản Apple Developer): lần đầu mở, macOS sẽ chặn; vào System Settings > Privacy & Security, bấm Open Anyway.

## Phát hành

Sửa `version` trong `desktop/app/package.json`, commit, rồi đẩy tag cùng số phiên bản:

```bash
git tag v0.1.3
```

```bash
git push origin v0.1.3
```

GitHub Actions build bản macOS và Windows rồi đưa lên trang Releases.

## AI

Người dùng tự nhập API key của mình trong phần Cài đặt (Claude hoặc Gemini), hoặc không dùng AI. Key được mã hoá bằng keychain của hệ điều hành.

## Lưu ý trước khi phát hành rộng

- Ảnh vệ tinh lấy từ Esri World Imagery, dữ liệu đường từ OpenStreetMap. Điều khoản của hai nguồn này không cho dùng trực tiếp trong app phát hành rộng; hiện chỉ dùng nội bộ.
- Remotion miễn phí cho cá nhân và công ty tối đa 3 người; lớn hơn cần giấy phép công ty.
