// 提示词管理器 - Rust 后端
use serde::{Deserialize, Serialize};
use std::fs;
use std::path::PathBuf;
use tauri::{
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    Manager, WindowEvent,
};
use walkdir::WalkDir;

// 提示词数据结构
#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct Prompt {
    pub id: String,
    pub title: String,
    pub content: String,
    pub category: String,
    pub file_path: String,
}

// 应用配置
#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct AppConfig {
    pub prompts_folder: String,
    pub hotkey: String,
    #[serde(default = "default_theme")]
    pub theme: String,
    #[serde(default)]
    pub autostart: bool,
}

fn default_theme() -> String {
    "dark".to_string()
}

impl Default for AppConfig {
    fn default() -> Self {
        Self {
            prompts_folder: String::new(),
            hotkey: "Alt+Space".to_string(),
            theme: "dark".to_string(),
            autostart: false,
        }
    }
}

// 获取配置文件路径
fn get_config_path() -> PathBuf {
    let config_dir = dirs::config_dir()
        .unwrap_or_else(|| PathBuf::from("."))
        .join("prompt-manager");
    fs::create_dir_all(&config_dir).ok();
    config_dir.join("config.json")
}

// 获取配置文件路径（供前端显示）
#[tauri::command]
fn get_config_path_str() -> String {
    get_config_path().to_string_lossy().to_string()
}

// 读取配置
#[tauri::command]
fn get_config() -> Result<AppConfig, String> {
    let config_path = get_config_path();
    if config_path.exists() {
        let content = fs::read_to_string(&config_path)
            .map_err(|e| format!("读取配置失败: {}", e))?;
        serde_json::from_str(&content)
            .map_err(|e| format!("解析配置失败: {}", e))
    } else {
        Ok(AppConfig::default())
    }
}

// 保存配置
#[tauri::command]
fn save_config(config: AppConfig) -> Result<(), String> {
    let config_path = get_config_path();
    let content = serde_json::to_string_pretty(&config)
        .map_err(|e| format!("序列化配置失败: {}", e))?;
    fs::write(&config_path, content)
        .map_err(|e| format!("保存配置失败: {}", e))
}

// ====== 助记词元数据 ======

// 助记词映射数据结构
#[derive(Debug, Serialize, Deserialize, Clone, Default)]
pub struct PromptsMeta {
    // mnemonic -> file_path
    pub mnemonics: std::collections::HashMap<String, String>,
}

// 获取元数据文件路径
fn get_meta_path() -> PathBuf {
    let config_dir = dirs::config_dir()
        .unwrap_or_else(|| PathBuf::from("."))
        .join("prompt-manager");
    fs::create_dir_all(&config_dir).ok();
    config_dir.join("prompts-meta.json")
}

// 读取助记词元数据
#[tauri::command]
fn get_prompts_meta() -> Result<PromptsMeta, String> {
    let meta_path = get_meta_path();
    if meta_path.exists() {
        let content = fs::read_to_string(&meta_path)
            .map_err(|e| format!("读取元数据失败: {}", e))?;
        serde_json::from_str(&content)
            .map_err(|e| format!("解析元数据失败: {}", e))
    } else {
        Ok(PromptsMeta::default())
    }
}

// 保存助记词元数据
fn save_prompts_meta(meta: &PromptsMeta) -> Result<(), String> {
    let meta_path = get_meta_path();
    let content = serde_json::to_string_pretty(meta)
        .map_err(|e| format!("序列化元数据失败: {}", e))?;
    fs::write(&meta_path, content)
        .map_err(|e| format!("保存元数据失败: {}", e))
}

// 设置助记词
#[tauri::command]
fn set_mnemonic(mnemonic: String, file_path: String) -> Result<(), String> {
    let mnemonic = mnemonic.trim().to_lowercase();
    if mnemonic.is_empty() {
        return Err("助记词不能为空".to_string());
    }

    let mut meta = get_prompts_meta()?;

    // 检查是否已被其他文件使用
    if let Some(existing_path) = meta.mnemonics.get(&mnemonic) {
        if existing_path != &file_path {
            return Err(format!("助记词 '{}' 已被其他文件使用", mnemonic));
        }
    }

    // 移除该文件之前的助记词（如果有）
    meta.mnemonics.retain(|_, v| v != &file_path);

    // 设置新助记词
    meta.mnemonics.insert(mnemonic, file_path);
    save_prompts_meta(&meta)
}

// 删除助记词
#[tauri::command]
fn remove_mnemonic(file_path: String) -> Result<(), String> {
    let mut meta = get_prompts_meta()?;
    meta.mnemonics.retain(|_, v| v != &file_path);
    save_prompts_meta(&meta)
}

// 通过助记词查找文件路径
#[tauri::command]
fn find_by_mnemonic(mnemonic: String) -> Result<Option<String>, String> {
    let mnemonic = mnemonic.trim().to_lowercase();
    let meta = get_prompts_meta()?;
    Ok(meta.mnemonics.get(&mnemonic).cloned())
}

// 获取文件的助记词
#[tauri::command]
fn get_mnemonic_for_file(file_path: String) -> Result<Option<String>, String> {
    let meta = get_prompts_meta()?;
    for (m, p) in &meta.mnemonics {
        if p == &file_path {
            return Ok(Some(m.clone()));
        }
    }
    Ok(None)
}

// 助记词列表项
#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct MnemonicItem {
    pub mnemonic: String,
    pub title: String,
    pub content: String,
}

// 获取所有提示词（用于快速插入弹窗，支持全文检索）
#[tauri::command]
fn get_all_mnemonics() -> Result<Vec<MnemonicItem>, String> {
    let config = get_config()?;
    if config.prompts_folder.is_empty() {
        return Ok(Vec::new());
    }

    let meta = get_prompts_meta()?;
    let mut items = Vec::new();

    // 遍历所有 md 文件
    for entry in WalkDir::new(&config.prompts_folder)
        .into_iter()
        .filter_map(|e| e.ok())
        .filter(|e| e.path().extension().map_or(false, |ext| ext == "md" || ext == "txt"))
    {
        let path = entry.path();
        let file_path = path.to_string_lossy().to_string();
        let title = path.file_stem()
            .map(|s| s.to_string_lossy().to_string())
            .unwrap_or_default();
        let content = std::fs::read_to_string(path).unwrap_or_default();

        // 查找该文件的助记词
        let mnemonic = meta.mnemonics.iter()
            .find(|(_, p)| *p == &file_path)
            .map(|(m, _)| m.clone())
            .unwrap_or_default();

        items.push(MnemonicItem {
            mnemonic,
            title,
            content,
        });
    }

    // 按标题排序
    items.sort_by(|a, b| a.title.cmp(&b.title));
    Ok(items)
}

// 显示快速插入弹窗
#[tauri::command]
async fn show_popup(app: tauri::AppHandle) -> Result<(), String> {
    use tauri::Manager;

    // 获取鼠标位置并计算弹窗位置
    let (cursor_x, cursor_y) = get_cursor_position();
    let (x, y) = calculate_popup_position(cursor_x, cursor_y);

    if let Some(popup) = app.get_webview_window("popup") {
        // 设置位置并显示
        popup.set_position(tauri::PhysicalPosition::new(x, y)).ok();
        popup.show().map_err(|e| e.to_string())?;
        popup.set_focus().ok();
    }
    Ok(())
}

// 隐藏快速插入弹窗
#[tauri::command]
async fn hide_popup(app: tauri::AppHandle) -> Result<(), String> {
    use tauri::Manager;
    if let Some(popup) = app.get_webview_window("popup") {
        popup.hide().map_err(|e| e.to_string())?;
    }
    Ok(())
}

// 获取当前鼠标位置 (Windows)
fn get_cursor_position() -> (i32, i32) {
    #[cfg(target_os = "windows")]
    {
        use windows::Win32::UI::WindowsAndMessaging::GetCursorPos;
        use windows::Win32::Foundation::POINT;
        let mut point = POINT { x: 0, y: 0 };
        unsafe {
            let _ = GetCursorPos(&mut point);
        }
        (point.x, point.y)
    }
    #[cfg(not(target_os = "windows"))]
    {
        (100, 100) // 默认位置
    }
}

// 获取光标所在显示器的工作区域
fn get_monitor_work_area(cursor_x: i32, cursor_y: i32) -> (i32, i32, i32, i32) {
    #[cfg(target_os = "windows")]
    {
        use windows::Win32::Graphics::Gdi::{MonitorFromPoint, GetMonitorInfoW, MONITORINFO, MONITOR_DEFAULTTONEAREST};
        use windows::Win32::Foundation::POINT;

        let point = POINT { x: cursor_x, y: cursor_y };
        unsafe {
            let monitor = MonitorFromPoint(point, MONITOR_DEFAULTTONEAREST);
            let mut info = MONITORINFO {
                cbSize: std::mem::size_of::<MONITORINFO>() as u32,
                ..Default::default()
            };
            if GetMonitorInfoW(monitor, &mut info).as_bool() {
                let rc = info.rcWork;
                return (rc.left, rc.top, rc.right, rc.bottom);
            }
        }
        (0, 0, 1920, 1080) // 默认值
    }
    #[cfg(not(target_os = "windows"))]
    {
        (0, 0, 1920, 1080) // 默认值
    }
}

// 弹窗尺寸常量（考虑 DPI 缩放，使用较大的估算值）
const POPUP_WIDTH: i32 = 450;  // 300 * 1.5 DPI
const POPUP_HEIGHT: i32 = 600; // 400 * 1.5 DPI
const MARGIN: i32 = 10; // 边距

// 计算弹窗位置（智能判断向上或向下弹出）
fn calculate_popup_position(cursor_x: i32, cursor_y: i32) -> (i32, i32) {
    let (work_left, work_top, work_right, work_bottom) = get_monitor_work_area(cursor_x, cursor_y);

    let mut x = cursor_x;
    let mut y = cursor_y;

    // 判断是否在屏幕下半部分（如果光标下方空间不足以显示弹窗）
    if cursor_y + POPUP_HEIGHT + MARGIN > work_bottom {
        // 向上弹出（光标上方）
        y = cursor_y - POPUP_HEIGHT - MARGIN;
    }

    // 确保不超出左右边界
    if x + POPUP_WIDTH > work_right - MARGIN {
        x = work_right - POPUP_WIDTH - MARGIN;
    }
    if x < work_left + MARGIN {
        x = work_left + MARGIN;
    }

    // 确保不超出上边界
    if y < work_top + MARGIN {
        y = work_top + MARGIN;
    }

    (x, y)
}

// 扫描所有子文件夹
#[tauri::command]
fn scan_folders(folder: String) -> Result<Vec<String>, String> {
    let folder_path = PathBuf::from(&folder);
    if !folder_path.exists() {
        return Err("文件夹不存在".to_string());
    }

    let mut folders = Vec::new();

    for entry in WalkDir::new(&folder_path)
        .into_iter()
        .filter_map(|e| e.ok())
        .filter(|e| e.path().is_dir() && e.path() != folder_path)
    {
        folders.push(entry.path().to_string_lossy().to_string());
    }

    Ok(folders)
}

// 扫描提示词文件夹
#[tauri::command]
fn scan_prompts(folder: String) -> Result<Vec<Prompt>, String> {
    let folder_path = PathBuf::from(&folder);
    if !folder_path.exists() {
        return Err("文件夹不存在".to_string());
    }

    let mut prompts = Vec::new();

    for entry in WalkDir::new(&folder_path)
        .into_iter()
        .filter_map(|e| e.ok())
        .filter(|e| e.path().extension().map_or(false, |ext| ext == "md" || ext == "txt"))
    {
        let path = entry.path();
        let file_path = path.to_string_lossy().to_string();

        let title = path.file_stem()
            .map(|s| s.to_string_lossy().to_string())
            .unwrap_or_default();

        let category = path.parent()
            .and_then(|p| p.strip_prefix(&folder_path).ok())
            .map(|p| p.to_string_lossy().to_string())
            .unwrap_or_else(|| "默认".to_string());
        let category = if category.is_empty() { "默认".to_string() } else { category };

        let content = fs::read_to_string(path).unwrap_or_default();
        let id = format!("{:x}", md5_hash(&file_path));

        prompts.push(Prompt {
            id,
            title,
            content,
            category,
            file_path,
        });
    }

    Ok(prompts)
}

fn md5_hash(s: &str) -> u64 {
    use std::collections::hash_map::DefaultHasher;
    use std::hash::{Hash, Hasher};
    let mut hasher = DefaultHasher::new();
    s.hash(&mut hasher);
    hasher.finish()
}

// 保存提示词 - 优化：原地重命名
#[tauri::command]
fn save_prompt(
    folder: String,
    category: String,
    title: String,
    content: String,
    original_path: Option<String>
) -> Result<String, String> {
    let mut target_folder = PathBuf::from(&folder);

    // 如果有分类，创建子目录
    if !category.is_empty() && category != "默认" {
        target_folder = target_folder.join(&category);
        fs::create_dir_all(&target_folder).map_err(|e| format!("创建目录失败: {}", e))?;
    }

    // 保持原有扩展名，新建默认用 md
    let ext = original_path.as_ref()
        .and_then(|p| PathBuf::from(p).extension().map(|e| e.to_string_lossy().to_string()))
        .unwrap_or_else(|| "md".to_string());

    let file_name = format!("{}.{}", title, ext);
    let target_path = target_folder.join(&file_name);
    let target_path_str = target_path.to_string_lossy().to_string();

    // 如果有原路径，且与新路径不同，执行重命名
    if let Some(ref orig) = original_path {
        let orig_path = PathBuf::from(orig);
        if orig_path != target_path && orig_path.exists() {
            // 执行重命名
            fs::rename(&orig_path, &target_path)
                .map_err(|e| format!("重命名失败: {}", e))?;
        }
    }

    // 写入最新内容
    fs::write(&target_path, &content).map_err(|e| format!("保存文件失败: {}", e))?;

    Ok(target_path_str)
}

// 删除提示词
#[tauri::command]
fn delete_prompt(file_path: String) -> Result<(), String> {
    fs::remove_file(&file_path).map_err(|e| format!("删除失败: {}", e))
}

// 新建文件
#[tauri::command]
fn create_file(folder: String) -> Result<String, String> {
    let folder_path = PathBuf::from(&folder);
    if !folder_path.exists() {
        return Err("文件夹不存在".to_string());
    }

    // 生成默认文件名
    let mut index = 1;
    let mut file_path;
    loop {
        let name = if index == 1 {
            "新建提示词.md".to_string()
        } else {
            format!("新建提示词 {}.md", index)
        };
        file_path = folder_path.join(&name);
        if !file_path.exists() {
            break;
        }
        index += 1;
    }

    // 创建空文件
    fs::write(&file_path, "").map_err(|e| format!("创建文件失败: {}", e))?;
    Ok(file_path.to_string_lossy().to_string())
}

// 新建文件夹
#[tauri::command]
fn create_folder(parent_folder: String) -> Result<String, String> {
    let parent_path = PathBuf::from(&parent_folder);
    if !parent_path.exists() {
        return Err("父文件夹不存在".to_string());
    }

    // 生成默认文件夹名
    let mut index = 1;
    let mut folder_path;
    loop {
        let name = if index == 1 {
            "新建文件夹".to_string()
        } else {
            format!("新建文件夹 {}", index)
        };
        folder_path = parent_path.join(&name);
        if !folder_path.exists() {
            break;
        }
        index += 1;
    }

    // 创建文件夹
    fs::create_dir(&folder_path).map_err(|e| format!("创建文件夹失败: {}", e))?;
    Ok(folder_path.to_string_lossy().to_string())
}

// 重命名文件夹
#[tauri::command]
fn rename_folder(old_path: String, new_name: String) -> Result<String, String> {
    let old_path_buf = PathBuf::from(&old_path);
    if !old_path_buf.exists() || !old_path_buf.is_dir() {
        return Err("文件夹不存在".to_string());
    }

    let parent = old_path_buf.parent().ok_or("无法获取父目录")?;
    let new_path = parent.join(&new_name);

    if new_path.exists() {
        return Err("目标名称已存在".to_string());
    }

    fs::rename(&old_path_buf, &new_path).map_err(|e| format!("重命名失败: {}", e))?;
    Ok(new_path.to_string_lossy().to_string())
}

// 删除文件夹
#[tauri::command]
fn delete_folder(folder_path: String) -> Result<(), String> {
    let path = PathBuf::from(&folder_path);
    if !path.exists() || !path.is_dir() {
        return Err("文件夹不存在".to_string());
    }
    fs::remove_dir_all(&path).map_err(|e| format!("删除文件夹失败: {}", e))
}

// 在文件资源管理器中打开
#[tauri::command]
fn open_in_explorer(path: String) -> Result<(), String> {
    let path_buf = PathBuf::from(&path);
    let folder = if path_buf.is_file() {
        path_buf.parent().map(|p| p.to_path_buf()).unwrap_or(path_buf)
    } else {
        path_buf
    };

    #[cfg(target_os = "windows")]
    {
        std::process::Command::new("explorer")
            .arg(folder)
            .spawn()
            .map_err(|e| format!("打开失败: {}", e))?;
    }

    Ok(())
}

// 复制到剪贴板
#[tauri::command]
fn copy_to_clipboard(app: tauri::AppHandle, text: String) -> Result<(), String> {
    use tauri_plugin_clipboard_manager::ClipboardExt;
    app.clipboard().write_text(&text)
        .map_err(|e| format!("复制失败: {}", e))
}

// 读取剪贴板内容
#[tauri::command]
fn read_clipboard(app: tauri::AppHandle) -> Result<String, String> {
    use tauri_plugin_clipboard_manager::ClipboardExt;
    app.clipboard().read_text()
        .map_err(|e| format!("读取剪贴板失败: {}", e))
}

// 模拟键盘输入（使用剪贴板粘贴方式，支持中文）
#[tauri::command]
fn type_text(app: tauri::AppHandle, text: String) -> Result<(), String> {
    use enigo::{Enigo, Key, Keyboard, Settings};
    use tauri_plugin_clipboard_manager::ClipboardExt;

    // 1. 先将文本复制到剪贴板
    app.clipboard().write_text(&text)
        .map_err(|e| format!("复制到剪贴板失败: {}", e))?;

    // 2. 等待一下确保剪贴板已更新
    std::thread::sleep(std::time::Duration::from_millis(50));

    // 3. 模拟 Ctrl+V 粘贴
    let mut enigo = Enigo::new(&Settings::default())
        .map_err(|e| format!("初始化输入失败: {}", e))?;

    // 按下 Ctrl+V
    enigo.key(Key::Control, enigo::Direction::Press)
        .map_err(|e| format!("按键失败: {}", e))?;
    enigo.key(Key::Unicode('v'), enigo::Direction::Click)
        .map_err(|e| format!("按键失败: {}", e))?;
    enigo.key(Key::Control, enigo::Direction::Release)
        .map_err(|e| format!("按键失败: {}", e))?;

    Ok(())
}

// 纯模拟键盘输入（使用 Windows SendInput，支持中文，逐字符输入，ESC可取消）
#[tauri::command]
fn type_text_simulate(text: String) -> Result<(), String> {
    #[cfg(target_os = "windows")]
    {
        use windows::Win32::UI::Input::KeyboardAndMouse::{SendInput, INPUT, INPUT_KEYBOARD, KEYBDINPUT, KEYEVENTF_UNICODE, KEYEVENTF_KEYUP, GetAsyncKeyState};

        std::thread::sleep(std::time::Duration::from_millis(100));

        const VK_ESCAPE: i32 = 0x1B;

        for c in text.encode_utf16() {
            // 检测 ESC 键是否按下
            unsafe {
                if GetAsyncKeyState(VK_ESCAPE) & 0x8000u16 as i16 != 0 {
                    return Ok(()); // 用户按下 ESC，取消输入
                }
            }

            let inputs = [
                // Key down
                INPUT {
                    r#type: INPUT_KEYBOARD,
                    Anonymous: windows::Win32::UI::Input::KeyboardAndMouse::INPUT_0 {
                        ki: KEYBDINPUT {
                            wVk: windows::Win32::UI::Input::KeyboardAndMouse::VIRTUAL_KEY(0),
                            wScan: c,
                            dwFlags: KEYEVENTF_UNICODE,
                            time: 0,
                            dwExtraInfo: 0,
                        },
                    },
                },
                // Key up
                INPUT {
                    r#type: INPUT_KEYBOARD,
                    Anonymous: windows::Win32::UI::Input::KeyboardAndMouse::INPUT_0 {
                        ki: KEYBDINPUT {
                            wVk: windows::Win32::UI::Input::KeyboardAndMouse::VIRTUAL_KEY(0),
                            wScan: c,
                            dwFlags: KEYEVENTF_UNICODE | KEYEVENTF_KEYUP,
                            time: 0,
                            dwExtraInfo: 0,
                        },
                    },
                },
            ];

            unsafe {
                SendInput(&inputs, std::mem::size_of::<INPUT>() as i32);
            }

            // 每个字符之间延迟 2ms，模拟正常输入
            std::thread::sleep(std::time::Duration::from_millis(2));
        }

        Ok(())
    }
    #[cfg(not(target_os = "windows"))]
    {
        Err("模拟输入仅支持 Windows".to_string())
    }
}

// 设置开机自启
#[tauri::command]
fn set_autostart(enable: bool) -> Result<(), String> {
    #[cfg(target_os = "windows")]
    {
        use std::env;
        use windows::Win32::System::Registry::{
            RegOpenKeyExW, RegSetValueExW, RegDeleteValueW, RegCloseKey,
            HKEY_CURRENT_USER, KEY_WRITE, REG_SZ,
        };
        use windows::core::PCWSTR;

        let key_path: Vec<u16> = "Software\\Microsoft\\Windows\\CurrentVersion\\Run\0"
            .encode_utf16().collect();
        let app_name: Vec<u16> = "PromptManager\0".encode_utf16().collect();

        unsafe {
            let mut hkey = windows::Win32::System::Registry::HKEY::default();
            let result = RegOpenKeyExW(
                HKEY_CURRENT_USER,
                PCWSTR(key_path.as_ptr()),
                0,
                KEY_WRITE,
                &mut hkey,
            );

            if result.is_err() {
                return Err("无法打开注册表".to_string());
            }

            if enable {
                // 获取当前可执行文件路径
                let exe_path = env::current_exe()
                    .map_err(|e| format!("获取程序路径失败: {}", e))?;
                let exe_path_str = exe_path.to_string_lossy();
                let mut exe_path_wide: Vec<u16> = exe_path_str.encode_utf16().collect();
                exe_path_wide.push(0);

                let result = RegSetValueExW(
                    hkey,
                    PCWSTR(app_name.as_ptr()),
                    0,
                    REG_SZ,
                    Some(std::slice::from_raw_parts(
                        exe_path_wide.as_ptr() as *const u8,
                        exe_path_wide.len() * 2,
                    )),
                );

                RegCloseKey(hkey);

                if result.is_err() {
                    return Err("设置开机自启失败".to_string());
                }
            } else {
                let _ = RegDeleteValueW(hkey, PCWSTR(app_name.as_ptr()));
                RegCloseKey(hkey);
            }
        }

        // 保存配置
        let mut config = get_config()?;
        config.autostart = enable;
        save_config(config)?;

        Ok(())
    }
    #[cfg(not(target_os = "windows"))]
    {
        Err("开机自启仅支持 Windows".to_string())
    }
}

// 设置窗口主题（动态切换标题栏颜色）
#[tauri::command]
fn set_window_theme(app: tauri::AppHandle, theme: String) -> Result<(), String> {
    use tauri::Manager;

    let tauri_theme = match theme.to_lowercase().as_str() {
        "light" => Some(tauri::Theme::Light),
        "dark" => Some(tauri::Theme::Dark),
        _ => None,
    };

    // 设置主窗口主题
    if let Some(main_window) = app.get_webview_window("main") {
        main_window.set_theme(tauri_theme).map_err(|e| format!("设置主题失败: {}", e))?;
    }

    Ok(())
}

// 更新快捷键
#[tauri::command]
fn update_hotkey(app: tauri::AppHandle, new_hotkey: String) -> Result<(), String> {
    use std::str::FromStr;
    use tauri_plugin_global_shortcut::{GlobalShortcutExt, Shortcut, ShortcutState};
    use tauri::Manager;

    // 1. 获取旧配置并注销
    let mut config = get_config()?;
    if let Ok(old_shortcut) = Shortcut::from_str(&config.hotkey) {
        let _ = app.global_shortcut().unregister(old_shortcut);
    }

    // 2. 尝试注册新快捷键（使用 on_shortcuts 同时注册快捷键和处理器）
    let shortcut = Shortcut::from_str(&new_hotkey)
        .map_err(|e| format!("快捷键格式错误: {:?}", e))?;

    app.global_shortcut().on_shortcuts([shortcut], move |app_handle, _shortcut, event| {
        if event.state == ShortcutState::Pressed {
            let (cursor_x, cursor_y) = get_cursor_position();
            let (x, y) = calculate_popup_position(cursor_x, cursor_y);
            let app_handle = app_handle.clone();
            tauri::async_runtime::spawn(async move {
                if let Some(popup) = app_handle.get_webview_window("popup") {
                    if popup.is_visible().unwrap_or(false) {
                        let _ = popup.hide();
                    } else {
                        let _ = popup.set_position(tauri::PhysicalPosition::new(x, y));
                        let _ = popup.show();
                        let _ = popup.set_focus();
                    }
                }
            });
        }
    }).map_err(|e| format!("注册快捷键失败(可能已被占用): {:?}", e))?;

    // 3. 保存新配置
    config.hotkey = new_hotkey;
    save_config(config)?;

    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(tauri_plugin_global_shortcut::Builder::new().build())
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            // 注册全局快捷键
            #[cfg(desktop)]
            {
                use tauri_plugin_global_shortcut::{GlobalShortcutExt, Shortcut, ShortcutState};
                use std::str::FromStr;
                use tauri::Manager;

                // 从配置读取并注册快捷键
                if let Ok(config) = get_config() {
                    // 启动时应用保存的主题
                    if let Some(main_window) = app.get_webview_window("main") {
                        let theme = match config.theme.as_str() {
                            "light" => Some(tauri::Theme::Light),
                            _ => Some(tauri::Theme::Dark),
                        };
                        let _ = main_window.set_theme(theme);
                    }

                    if let Ok(shortcut) = Shortcut::from_str(&config.hotkey) {
                        // 先尝试注销(清理可能的僵尸引用)
                        let _ = app.global_shortcut().unregister(shortcut.clone());

                        // 使用 on_shortcuts 同时注册快捷键和处理器
                        if let Err(e) = app.global_shortcut().on_shortcuts([shortcut], move |app_handle, _shortcut, event| {
                            if event.state == ShortcutState::Pressed {
                                let (cursor_x, cursor_y) = get_cursor_position();
                                let (x, y) = calculate_popup_position(cursor_x, cursor_y);
                                let app_handle = app_handle.clone();
                                tauri::async_runtime::spawn(async move {
                                    if let Some(popup) = app_handle.get_webview_window("popup") {
                                        if popup.is_visible().unwrap_or(false) {
                                            let _ = popup.hide();
                                        } else {
                                            let _ = popup.set_position(tauri::PhysicalPosition::new(x, y));
                                            let _ = popup.show();
                                            let _ = popup.set_focus();
                                        }
                                    }
                                });
                            }
                        }) {
                            eprintln!("启动时注册快捷键失败: {:?}", e);
                        } else {
                            println!("快捷键 {} 已注册", config.hotkey);
                        }
                    }
                }
            }

            // 创建系统托盘菜单
            use tauri::menu::{Menu, MenuItem};
            let show_item = MenuItem::with_id(app, "show", "显示主窗口", true, None::<&str>)?;
            let quit_item = MenuItem::with_id(app, "quit", "退出", true, None::<&str>)?;
            let menu = Menu::with_items(app, &[&show_item, &quit_item])?;

            // 创建系统托盘
            let _tray = TrayIconBuilder::new()
                .tooltip("提示词管理器")
                .icon(app.default_window_icon().unwrap().clone())
                .menu(&menu)
                .on_menu_event(|app, event| {
                    match event.id.as_ref() {
                        "show" => {
                            if let Some(window) = app.get_webview_window("main") {
                                let _ = window.show();
                                let _ = window.set_focus();
                            }
                        }
                        "quit" => {
                            app.exit(0);
                        }
                        _ => {}
                    }
                })
                .on_tray_icon_event(|tray, event| {
                    if let TrayIconEvent::Click {
                        button: MouseButton::Left,
                        button_state: MouseButtonState::Up,
                        ..
                    } = event
                    {
                        let app = tray.app_handle();
                        if let Some(window) = app.get_webview_window("main") {
                            let _ = window.show();
                            let _ = window.set_focus();
                        }
                    }
                })
                .build(app)?;

            // 监听窗口关闭事件 - 最小化到托盘
            let main_window = app.get_webview_window("main").unwrap();
            let app_handle = app.app_handle().clone();
            main_window.on_window_event(move |event| {
                if let WindowEvent::CloseRequested { api, .. } = event {
                    api.prevent_close();
                    // 隐藏窗口而不是关闭
                    if let Some(window) = app_handle.get_webview_window("main") {
                        let _ = window.hide();
                    }
                }
            });

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            get_config,
            get_config_path_str,
            save_config,
            get_prompts_meta,
            set_mnemonic,
            remove_mnemonic,
            find_by_mnemonic,
            get_mnemonic_for_file,
            get_all_mnemonics,
            show_popup,
            hide_popup,
            scan_prompts,
            save_prompt,
            delete_prompt,
            open_in_explorer,
            copy_to_clipboard,
            read_clipboard,
            type_text,
            type_text_simulate,
            set_autostart,
            update_hotkey,
            set_window_theme,
            create_file,
            create_folder,
            rename_folder,
            delete_folder,
            scan_folders
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
