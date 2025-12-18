# 提示词管理器 (Prompt Manager)

一个轻量级的桌面提示词管理工具，基于 Tauri 2.x + Vanilla JS 构建。

## 功能特性

- **提示词管理** - 创建、编辑、删除提示词文件
- **文件夹组织** - 支持多级文件夹分类管理
- **助记词系统** - 为提示词设置助记词，快速搜索定位
- **全局快捷键** - 通过快捷键呼出快速插入弹窗
- **主题切换** - 支持深色/浅色主题
- **SSH 远程同步** - 通过 SSH 与远程服务器同步提示词（零内存开销）
- **开机自启** - 支持开机自动启动

## 技术栈

- **前端**: Vanilla JavaScript + CSS
- **后端**: Rust + Tauri 2.x
- **打包**: MSI (Windows)

## 开发

```bash
# 安装依赖
npm install

# 开发模式
npm run tauri dev

# 构建
npx tauri build
```

## 内存占用

后台静默运行约 **4MB** 内存。

## 截图

（待添加）

## License

MIT
