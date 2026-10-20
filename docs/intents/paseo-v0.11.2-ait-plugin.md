# paseo-v0.11.2-ait-plugin — Lên Paseo v0.11.2 và tách AIT Tracker thành plugin riêng

Repository: /Volumes/DataSSD/HomeWork/STACK/paseo, nhánh custom/v0.11.2 (v0.11.2 = 75953250959979b8f088bbca8dbd6ee61d0151b1 + custom/v0.11.1 @ 73c3a367e).
Repo thứ hai: /Volumes/DataSSD/HomeWork/PLUGIN/paseo-ait-tracker (git local mới).

Outcome:

1. custom/v0.11.2 = upstream v0.11.2 + toàn bộ custom của custom/v0.11.1, typecheck và lint xanh.
2. AIT Tracker (màn Tracker, sidebar entry, daemon gọi `ait` CLI: stats, list có sort/pagination, search, chi tiết issue) chạy như Paseo plugin độc lập, cài qua directory source, đủ chức năng đang có trên custom/v0.11.1.
3. Trên custom/v0.11.2 gỡ code Tracker in-tree (app, server, protocol/feature flag riêng cho Tracker).
4. Plugin đúng khi daemon chạy cwd `/` (probe `ait --db :memory: list --help` không truyền cwd, lỗi prefix ở `/`, capability hạ thành false); All projects khi mọi project lỗi hiển thị lỗi, không phải bảng rỗng số 0.

Non-goals: không push/tag/publish; không restart daemon 6767; không cài plugin vào app desktop đang chạy; không sửa repo AIT CLI; không thêm tính năng Tracker mới ngoài hai lỗi ở Outcome 4; không đụng main ngoài fast-forward.

Locked: lên v0.11.2 trước, rồi plugin, rồi gỡ Tracker in-tree. Giữ nguyên custom/v0.11.1. Mẫu plugin: /Volumes/DataSSD/HomeWork/PLUGIN/paseo-prompt-kit. Peer routes: droid-peer/claude-sonnet-5-5, gpt-6-luna, deepseek-v4.1-flash. Không dual-seat, không council; một lượt review thường.

Invariants: custom khác Tracker vẫn hoạt động; .ait/ait.db không bị đọc ghi khác đi, probe không tạo DB; protocol backward-compatible (docs/protocol-compatibility.md); không gì rời máy.

Acceptance: git log chứa 75953250 và 73c3a367e, typecheck+lint xanh; `rg -il 'ait-cli-service|aitTracker' packages/app/src packages/server/src` rỗng (trừ shim COMPAT); plugin `npm run gate` xanh; trên dev daemon cài plugin, project tieuthuong-ai hiện 1020 issue, trang đầu và kế tiếp tải được, lọc priority/type/status chạy, mở chi tiết (ảnh hoặc log); test cwd `/` và All projects lỗi.

Open: plugin API v0.11.2 thiếu cho phần nào → DECISION_REQUEST, không gỡ chức năng, không sửa core mở API.
