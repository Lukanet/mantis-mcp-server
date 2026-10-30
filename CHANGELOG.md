# 更新日誌

## [Unreleased]

## [0.6.0] - 2026-10-30

### Added
- `list_issue_attachments` lists an issue's files, including the ones uploaded with a
  note, without dragging along every note and the history the way `get_issue_by_id` does.
- `get_issue_attachment` reads one file. Images come back as images the model can look
  at, text files as text (UTF-8, falling back to windows-1251), and everything else -
  pdf, zip, office documents - is saved under the system temp directory and its path
  returned, since the server runs locally over stdio.
- `upload_issue_attachment` attaches files to an issue, from local paths or inline
  (text or base64), optionally together with a note so the files sit under the note
  that explains them.
- `bulk_add_note` accepts `notes`, a text per issue, next to the existing shared
  `text`. A mass close carries a different reason on every issue; a shared note
  throws exactly that away.
- `tag` on both bulk tools attaches one tag to every issue touched, so a sweep can
  be reviewed - or undone - with a single filter instead of a search through note texts.
- `dryRun` on both bulk tools reports what would happen and writes nothing.

### Changed
- `priority` and `severity` on `create_issue`, `update_issue` and `bulk_update_issues`
  accept only the tracker's names (`none`..`immediate`, `feature`..`block`), the same
  way `status` already did, instead of passing an unknown name through.
- `add_issue_note` `view_state` is restricted to `public` / `private`.
- Tool descriptions point to each other where an agent would otherwise guess: where
  attachments are read and added, that `categoryId` must not be left out, that a new
  `description` replaces the old one, that a change is explained with a note.
- Both bulk tools now accept any number of ids and split the batch into requests of
  100 themselves. The caller no longer does that arithmetic.
- `suppressNotifications` is now required rather than defaulting to false. Left off,
  a batch of a few hundred issues mails every reporter, handler and monitor of every
  one of them - measured at four e-mails per note.

## [0.4.0] - 2024-03-29

### 改進
- 重構代碼，提取重複的 Mantis API 配置檢查邏輯到 `withMantisConfigured` 高階函數
- 優化錯誤處理，增加更清晰的錯誤標識和響應格式
- 增強日誌記錄，提供更詳細的錯誤上下文信息
- 優化 JSON 資料壓縮功能，根據資料大小自動判斷是否需要壓縮

### 重構
- 統一所有工具的實現方式，減少代碼重複
- 改進函數型別定義，使代碼更加類型安全
- 優化錯誤處理流程，提高代碼的可維護性

## [0.2.0] - 2024-03-21

### 新增
- 添加 `withMantisConfigured` 高階函數來處理共用的檢查邏輯
- 添加結構化的錯誤響應格式，包含 `isError` 標記

### 改進
- 優化所有工具的回傳型別以符合 MCP SDK 要求
- 改進錯誤處理機制，提供更詳細的錯誤信息
- 優化 `get_issues` 工具的壓縮功能
- 統一化所有工具的錯誤處理和日誌記錄

### 修復
- 修正工具回傳型別不符合 MCP SDK 要求的問題
- 修正錯誤響應格式不一致的問題

## [0.1.0] - 2024-03-20

### 新增
- 初始版本發布
- 實現基本的 Mantis API 集成
- 添加問題管理、用戶管理、專案管理等基本功能
- 實現統計分析功能
- 添加效能優化功能（欄位選擇、分頁處理、自動壓縮） 