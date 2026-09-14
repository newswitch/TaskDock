# TaskDock · 事项坞

Windows 右上角常驻的未解决事项跟踪器。

不是按「今天几点做什么」排日程，而是把还没解决的事情一直挂着，直到完成。

## 第一版功能

- 右上角悬浮、始终置顶、无边框半透明窗口
- 事项状态：待处理 / 处理中 / 等待他人 / 已完成
- 开始时间、预计完成时间、实际完成时间
- 自动显示已持续多久
- 优先级、备注
- 系统托盘（点击显示/隐藏）
- 开机自启（菜单内开关）
- 本地存储（本机 localStorage，无需账号）

## 开发

需要：

- Node.js 18+
- Rust（rustup）
- Windows 上建议安装 [Visual Studio Build Tools](https://visualstudio.microsoft.com/visual-cpp-build-tools/)（含 Desktop development with C++）

```bash
npm install
npm run tauri:dev
```

打包：

```bash
npm run tauri:build
```

## 使用提示

- 拖动顶部标题栏可移动窗口
- 点 `−` 或关闭按钮会隐藏到托盘，不会退出
- 托盘图标左键：显示/隐藏；右键：菜单
