// 提示词管理器 - 简约版
const { invoke } = window.__TAURI__.core;
const { ask } = window.__TAURI__.dialog;

let prompts = [];
let selectedPrompt = null;
let config = { prompts_folder: '', hotkey: 'Alt+Space', theme: 'dark', autostart: false, remote_sync: { enabled: false, server: '', remote_path: '', port: 22 } };
let contextTarget = null;
let autoSaveTimer = null;
const AUTO_SAVE_DELAY = 1000;

const $ = (sel) => document.querySelector(sel);

window.addEventListener('DOMContentLoaded', async () => {
    // 禁用默认右键菜单（除了文件树中的文件项）
    document.addEventListener('contextmenu', (e) => {
        // 只允许文件树中的文件项显示自定义右键菜单
        if (!e.target.closest('.tree-item[data-id]') && !e.target.closest('.tree-item.folder')) {
            e.preventDefault();
        }
    });

    // 绑定事件
    $('#select-folder').addEventListener('click', selectFolder);
    $('#toggle-sidebar').addEventListener('click', toggleSidebar);
    $('#toggle-sidebar-collapsed').addEventListener('click', toggleSidebar);
    $('#new-btn').addEventListener('click', handleNewOrSave);

    // 自动保存监听
    $('#prompt-title').addEventListener('input', triggerAutoSave);
    $('#prompt-content').addEventListener('input', triggerAutoSave);

    // 快捷键监听
    document.addEventListener('keydown', (e) => {
        if ((e.ctrlKey || e.metaKey) && e.key === 's') {
            e.preventDefault();
            savePrompt(false); // 手动触发，显示提示
        }
    });

    // 助记词保存 (Enter 键)
    $('#prompt-mnemonic').addEventListener('keydown', async (e) => {
        if (e.key === 'Enter') {
            e.preventDefault();
            await saveMnemonic();
        }
    });
    // 助记词失焦时也保存
    $('#prompt-mnemonic').addEventListener('blur', saveMnemonic);


    // 右键菜单 - 文件
    $('#menu-delete').addEventListener('click', deleteFromMenu);
    $('#menu-open-folder').addEventListener('click', openInExplorer);

    // 右键菜单 - 文件夹
    $('#menu-new-file').addEventListener('click', createNewFileInFolder);
    $('#menu-new-folder').addEventListener('click', createNewFolderInFolder);
    $('#menu-rename-folder').addEventListener('click', renameFolderFromMenu);
    $('#menu-delete-folder').addEventListener('click', deleteFolderFromMenu);
    $('#menu-open-folder-2').addEventListener('click', openInExplorer);

    // 右键菜单 - 空白区域
    $('#menu-new-file-blank').addEventListener('click', createNewFileInRoot);
    $('#menu-new-folder-blank').addEventListener('click', createNewFolderInRoot);

    // 点击隐藏所有右键菜单
    document.addEventListener('click', hideAllContextMenus);

    // 设置模态框
    $('#settings-btn').addEventListener('click', openSettings);
    $('.close-btn').addEventListener('click', closeSettings);
    $('#save-settings-btn').addEventListener('click', saveSettings);

    // 同步模态框
    $('#sync-btn').addEventListener('click', openSyncModal);
    $('.close-sync').addEventListener('click', closeSyncModal);
    $('#sync-pull-btn').addEventListener('click', () => doSync('pull'));
    $('#sync-push-btn').addEventListener('click', () => doSync('push'));

    // 同步设置
    $('#sync-enabled-checkbox').addEventListener('change', toggleSyncSettings);
    $('#test-ssh-btn').addEventListener('click', testSshConnection);

    window.addEventListener('click', (e) => {
        if (e.target === $('#settings-modal')) {
            closeSettings();
        }
        if (e.target === $('#sync-modal')) {
            closeSyncModal();
        }
    });

    // 加载配置
    await loadConfig();
    // 全局快捷键 Ctrl+Q 已在 Rust 端注册
});

// 侧边栏展开/收起
function toggleSidebar() {
    $('#sidebar').classList.toggle('collapsed');
}

// 新建/保存按钮点击处理
function handleNewOrSave() {
    const btnText = $('#new-btn').textContent;
    if (btnText === '保存') {
        savePrompt(false);
    } else {
        createNewPrompt();
    }
}

// 新建提示词
function createNewPrompt() {
    if (!config.prompts_folder) {
        showToast('请先选择文件夹');
        return;
    }
    enterCreateMode();
    $('#prompt-title').focus();
}

async function loadConfig() {
    try {
        config = await invoke('get_config');
        if (config.prompts_folder) {
            const folderName = config.prompts_folder.split(/[/\\]/).pop();
            $('#folder-name').textContent = folderName;
            await loadPrompts();
        }
        // 应用主题
        applyTheme(config.theme || 'dark');
        // 程序启动时自动进入新建模式
        enterCreateMode();
    } catch (e) {
        console.error('加载配置失败:', e);
    }
}

// 应用主题
function applyTheme(theme) {
    document.documentElement.setAttribute('data-theme', theme);
}

// 进入新建模式（复用逻辑）
function enterCreateMode() {
    selectedPrompt = null;
    $('#file-tree').querySelectorAll('.tree-item').forEach(item => {
        item.classList.remove('active');
    });
    $('#prompt-title').value = '';
    $('#prompt-title').removeAttribute('readonly');
    $('#prompt-mnemonic').value = '';
    $('#prompt-content').value = '';
    $('#prompt-content').removeAttribute('readonly');
    $('#prompt-content').placeholder = '请输入文本...\n\nCtrl+S 保存';
    $('#new-btn').textContent = '保存';
}

async function selectFolder() {
    try {
        const { open } = window.__TAURI__.dialog;
        const folder = await open({
            directory: true,
            multiple: false,
            title: '选择提示词文件夹'
        });

        if (folder) {
            config.prompts_folder = folder;
            const folderName = folder.split(/[/\\]/).pop();
            $('#folder-name').textContent = folderName;
            await invoke('save_config', { config });
            await loadPrompts();
            showToast('已加载');
        }
    } catch (e) {
        console.error('选择文件夹失败:', e);
    }
}

let allFolders = []; // 存储所有文件夹路径

async function loadPrompts() {
    if (!config.prompts_folder) return;

    try {
        // 同时加载文件和文件夹
        const [promptsResult, foldersResult] = await Promise.all([
            invoke('scan_prompts', { folder: config.prompts_folder }),
            invoke('scan_folders', { folder: config.prompts_folder })
        ]);
        prompts = promptsResult;
        allFolders = foldersResult;
        renderFileTree();
    } catch (e) {
        console.error('加载失败:', e);
        showToast('加载失败');
    }
}

function renderFileTree() {
    const tree = $('#file-tree');

    // 构建文件夹树结构
    const folderTree = buildFolderTree(prompts, config.prompts_folder);

    if (Object.keys(folderTree.children).length === 0 && folderTree.files.length === 0) {
        tree.innerHTML = '<div class="tree-item" style="color: var(--text-light);">暂无提示词</div>';
    } else {
        tree.innerHTML = renderFolderNode(folderTree, 0, config.prompts_folder);
    }

    // 绑定文件点击和右键
    tree.querySelectorAll('.tree-item[data-id]').forEach(item => {
        item.addEventListener('click', () => selectPromptById(item.dataset.id));
        item.addEventListener('contextmenu', (e) => showFileContextMenu(e, item.dataset.path, item.dataset.id));
    });

    // 文件夹点击展开/折叠 + 右键
    tree.querySelectorAll('.tree-item.folder').forEach(item => {
        item.addEventListener('click', () => toggleFolder(item.dataset.path));
        item.addEventListener('contextmenu', (e) => showFolderContextMenu(e, item.dataset.path));
    });

    // 侧边栏空白区域右键
    tree.addEventListener('contextmenu', (e) => {
        if (e.target === tree) {
            showBlankContextMenu(e);
        }
    });
}

// 构建文件夹树结构
function buildFolderTree(prompts, rootFolder) {
    const root = { children: {}, files: [] };

    // 首先从后端获取的文件夹列表创建节点
    allFolders.forEach(folderFullPath => {
        const relativePath = folderFullPath.replace(rootFolder, '').replace(/^[/\\]/, '');
        if (!relativePath) return;

        const parts = relativePath.split(/[/\\]/);
        let current = root;
        parts.forEach(part => {
            if (!part) return;
            if (!current.children[part]) {
                current.children[part] = { children: {}, files: [] };
            }
            current = current.children[part];
        });
    });

    // 将文件放入对应文件夹
    prompts.forEach(p => {
        const relativePath = p.file_path.replace(rootFolder, '').replace(/^[/\\]/, '');
        const parts = relativePath.split(/[/\\]/);
        parts.pop(); // 移除文件名

        let current = root;
        parts.forEach(part => {
            if (!part) return;
            if (!current.children[part]) {
                current.children[part] = { children: {}, files: [] };
            }
            current = current.children[part];
        });
        current.files.push(p);
    });

    return root;
}

// 存储文件夹展开状态
let expandedFolders = new Set();

// 切换文件夹展开/折叠
function toggleFolder(folderPath) {
    if (expandedFolders.has(folderPath)) {
        expandedFolders.delete(folderPath);
    } else {
        expandedFolders.add(folderPath);
    }
    renderFileTree();
}

// 递归渲染文件夹节点
function renderFolderNode(node, depth, currentPath) {
    let html = '';

    // 渲染子文件夹
    Object.keys(node.children).sort().forEach(folderName => {
        const folderPath = currentPath + '\\' + folderName;
        const indentClass = depth > 0 ? `indent-${depth}` : '';
        const isExpanded = expandedFolders.has(folderPath);
        const icon = isExpanded ? '📂' : '📁';
        html += `<div class="tree-item folder ${indentClass}" data-path="${folderPath}" data-expanded="${isExpanded}"><span class="tree-icon">${icon}</span>${escapeHtml(folderName)}</div>`;

        // 只有展开时才渲染子内容
        if (isExpanded) {
            html += renderFolderNode(node.children[folderName], depth + 1, folderPath);
        }
    });

    // 渲染文件
    node.files.forEach(p => {
        const isActive = selectedPrompt && selectedPrompt.id === p.id ? 'active' : '';
        const indentClass = depth > 0 ? `indent-${depth}` : '';
        html += `<div class="tree-item ${indentClass} ${isActive}" data-id="${p.id}" data-path="${p.file_path}"><span class="tree-icon">📄</span>${escapeHtml(p.title)}</div>`;
    });

    return html;
}

function selectPromptById(id) {
    const prompt = prompts.find(p => p.id === id);
    if (!prompt) return;

    selectedPrompt = prompt;

    // 更新选中状态
    $('#file-tree').querySelectorAll('.tree-item').forEach(item => {
        item.classList.toggle('active', item.dataset.id === id);
    });

    // 显示内容
    $('#prompt-title').value = prompt.title;
    $('#prompt-title').removeAttribute('readonly');
    $('#prompt-content').value = prompt.content;
    $('#prompt-content').removeAttribute('readonly');
    $('#prompt-content').placeholder = '请输入文本...\n\nCtrl+S 保存';

    // 按钮变回"新建"
    $('#new-btn').textContent = '新建';

    // 加载助记词
    loadMnemonic(prompt.file_path);
}

// 加载助记词
async function loadMnemonic(filePath) {
    try {
        const mnemonic = await invoke('get_mnemonic_for_file', { filePath });
        $('#prompt-mnemonic').value = mnemonic || '';
    } catch (e) {
        console.error('加载助记词失败:', e);
        $('#prompt-mnemonic').value = '';
    }
}

// 保存助记词
async function saveMnemonic() {
    if (!selectedPrompt) return;

    const mnemonic = $('#prompt-mnemonic').value.trim();
    const filePath = selectedPrompt.file_path;

    try {
        if (mnemonic) {
            await invoke('set_mnemonic', { mnemonic, filePath });
        } else {
            // 如果助记词为空，删除它
            await invoke('remove_mnemonic', { filePath });
        }
    } catch (e) {
        showToast('助记词保存失败: ' + e);
    }
}

// 隐藏所有右键菜单
function hideAllContextMenus() {
    $('#context-menu-file').classList.add('hidden');
    $('#context-menu-folder').classList.add('hidden');
    $('#context-menu-blank').classList.add('hidden');
}

// 右键菜单 - 文件
function showFileContextMenu(e, path, id) {
    e.preventDefault();
    e.stopPropagation();
    hideAllContextMenus();

    contextTarget = { path, id, type: 'file' };

    const menu = $('#context-menu-file');
    menu.style.left = e.clientX + 'px';
    menu.style.top = e.clientY + 'px';
    menu.classList.remove('hidden');
}

// 右键菜单 - 文件夹
function showFolderContextMenu(e, path) {
    e.preventDefault();
    e.stopPropagation();
    hideAllContextMenus();

    contextTarget = { path, id: null, type: 'folder' };

    const menu = $('#context-menu-folder');
    menu.style.left = e.clientX + 'px';
    menu.style.top = e.clientY + 'px';
    menu.classList.remove('hidden');
}

// 右键菜单 - 空白区域（侧边栏）
function showBlankContextMenu(e) {
    e.preventDefault();
    e.stopPropagation();
    hideAllContextMenus();

    if (!config.prompts_folder) return;

    contextTarget = { path: config.prompts_folder, id: null, type: 'blank' };

    const menu = $('#context-menu-blank');
    menu.style.left = e.clientX + 'px';
    menu.style.top = e.clientY + 'px';
    menu.classList.remove('hidden');
}

async function deleteFromMenu() {
    if (!contextTarget) return;

    if (contextTarget.id) {
        const prompt = prompts.find(p => p.id === contextTarget.id);
        if (!prompt) return;

        // 先确认再删除
        // 注意：window.confirm 会阻塞 UI，建议使用 tauri 的 dialog
        // 这里使用 confirm 确保逻辑顺序正确：确认 -> 操作
        // 如果用户反馈顺序反了，可能是 invoke 是异步的，所以这里必须 await

        const yes = await ask(`确定要删除 "${prompt.title}" 吗？`, {
            title: '删除确认',
            kind: 'warning'
        });

        if (yes) {
            try {
                await invoke('delete_prompt', { filePath: prompt.file_path });
                if (selectedPrompt && selectedPrompt.id === prompt.id) {
                    selectedPrompt = null;
                    $('#prompt-title').value = '';
                    $('#prompt-content').value = '';
                }
                await loadPrompts();
                showToast('已删除');
            } catch (e) {
                showToast('删除失败: ' + e);
            }
        }
    }
    contextTarget = null;
}

async function openInExplorer() {
    if (!contextTarget || !contextTarget.path) return;

    try {
        await invoke('open_in_explorer', { path: contextTarget.path });
    } catch (e) {
        showToast('打开失败');
    }
    contextTarget = null;
}

// 在文件夹中新建文件
async function createNewFileInFolder() {
    if (!contextTarget || !contextTarget.path) return;

    try {
        const newPath = await invoke('create_file', { folder: contextTarget.path });
        await loadPrompts();
        // 选中新建的文件
        const newPrompt = prompts.find(p => p.file_path === newPath);
        if (newPrompt) {
            selectPromptById(newPrompt.id);
        }
        showToast('已创建');
    } catch (e) {
        showToast('创建失败: ' + e);
    }
    contextTarget = null;
}

// 在文件夹中新建子文件夹
async function createNewFolderInFolder() {
    if (!contextTarget || !contextTarget.path) return;

    try {
        await invoke('create_folder', { parentFolder: contextTarget.path });
        await loadPrompts();
        showToast('已创建文件夹');
    } catch (e) {
        showToast('创建失败: ' + e);
    }
    contextTarget = null;
}

// 在根目录新建文件
async function createNewFileInRoot() {
    if (!config.prompts_folder) return;

    try {
        const newPath = await invoke('create_file', { folder: config.prompts_folder });
        await loadPrompts();
        const newPrompt = prompts.find(p => p.file_path === newPath);
        if (newPrompt) {
            selectPromptById(newPrompt.id);
        }
        showToast('已创建');
    } catch (e) {
        showToast('创建失败: ' + e);
    }
    contextTarget = null;
}

// 在根目录新建文件夹
async function createNewFolderInRoot() {
    if (!config.prompts_folder) return;

    try {
        await invoke('create_folder', { parentFolder: config.prompts_folder });
        await loadPrompts();
        showToast('已创建文件夹');
    } catch (e) {
        showToast('创建失败: ' + e);
    }
    contextTarget = null;
}

// 重命名文件夹
async function renameFolderFromMenu() {
    if (!contextTarget || !contextTarget.path) return;

    const oldName = contextTarget.path.split(/[/\\]/).pop();
    const newName = prompt('请输入新名称:', oldName);

    if (!newName || newName === oldName) {
        contextTarget = null;
        return;
    }

    try {
        await invoke('rename_folder', { oldPath: contextTarget.path, newName });
        await loadPrompts();
        showToast('已重命名');
    } catch (e) {
        showToast('重命名失败: ' + e);
    }
    contextTarget = null;
}

// 删除文件夹
async function deleteFolderFromMenu() {
    if (!contextTarget || !contextTarget.path) return;

    const folderName = contextTarget.path.split(/[/\\]/).pop();
    const yes = await ask(`确定要删除文件夹 "${folderName}" 及其所有内容吗？`, {
        title: '删除确认',
        kind: 'warning'
    });

    if (yes) {
        try {
            await invoke('delete_folder', { folderPath: contextTarget.path });
            await loadPrompts();
            showToast('已删除文件夹');
        } catch (e) {
            showToast('删除失败: ' + e);
        }
    }
    contextTarget = null;
}

async function copyPrompt() {
    const content = $('#prompt-content').value;
    if (!content) {
        showToast('无内容');
        return;
    }

    try {
        await invoke('copy_to_clipboard', { app: null, text: content });
        showToast('已复制');
    } catch (e) {
        showToast('复制失败');
    }
}

// 自动保存触发器
function triggerAutoSave() {
    if (!selectedPrompt) return; // 没有选中文件时不自动保存

    if (autoSaveTimer) clearTimeout(autoSaveTimer);

    // 可以在这里添加 UI 状态指示，例如 "正在输入..."

    autoSaveTimer = setTimeout(async () => {
        await savePrompt(true); // silent mode
    }, AUTO_SAVE_DELAY);
}

async function savePrompt(silent = false) {
    const title = $('#prompt-title').value.trim();
    const content = $('#prompt-content').value;
    const mnemonic = $('#prompt-mnemonic').value.trim();

    if (!title) {
        if (!silent) showToast('请输入标题');
        return;
    }
    if (!config.prompts_folder) {
        if (!silent) showToast('请先选择文件夹');
        return;
    }

    try {
        const category = selectedPrompt?.category || '默认';
        const originalPath = selectedPrompt?.file_path || null;

        // 保存并获取新路径
        const newPath = await invoke('save_prompt', {
            folder: config.prompts_folder,
            category,
            title,
            content,
            originalPath
        });

        // 如果重命名了（路径改变），需要重新加载列表
        // 简单的路径比较，注意 Windows 分隔符
        const isRename = originalPath && newPath.replace(/\\/g, '/') !== originalPath.replace(/\\/g, '/');

        if (isRename || !selectedPrompt) {
            await loadPrompts();
            // 通过路径查找新 ID 并选中
            const newPrompt = prompts.find(p => p.file_path === newPath);
            if (newPrompt) {
                selectPromptById(newPrompt.id);
            }
        } else {
            // 如果只是内容更新，更新内存数据即可，不需要重刷列表
            if (selectedPrompt) {
                selectedPrompt.content = content;
                selectedPrompt.title = title;
                selectedPrompt.file_path = newPath; // 确保路径是最新的
            }
        }

        if (!silent) showToast('已保存');
        else console.log('自动保存成功');
    } catch (e) {
        console.error('保存失败:', e);
        if (!silent) showToast('保存失败: ' + e);
    }
}

function showToast(msg) {
    const old = document.querySelector('.toast');
    if (old) old.remove();

    const toast = document.createElement('div');
    toast.className = 'toast';
    toast.textContent = msg;
    document.body.appendChild(toast);
    setTimeout(() => toast.remove(), 2000);
}

// 设置相关函数
let isRecordingHotkey = false;

async function openSettings() {
    $('#hotkey-input').value = config.hotkey || 'Alt+Space';
    $('#theme-select').value = config.theme || 'dark';
    $('#autostart-checkbox').checked = config.autostart || false;

    // 远程同步设置
    const syncConfig = config.remote_sync || { enabled: false, server: '', remote_path: '', port: 22 };
    $('#sync-enabled-checkbox').checked = syncConfig.enabled;
    $('#sync-server').value = syncConfig.server || '';
    $('#sync-remote-path').value = syncConfig.remote_path || '';
    $('#sync-port').value = syncConfig.port || 22;
    $('#ssh-test-result').textContent = '';

    // 初始化同步设置状态
    toggleSyncSettings();

    // 检测 SSH 可用性
    checkSshAvailable();

    // 加载配置文件路径
    try {
        const configPath = await invoke('get_config_path_str');
        $('#config-path').textContent = configPath;
        $('#config-path').onclick = async () => {
            await invoke('copy_to_clipboard', { text: configPath });
            showToast('路径已复制');
        };
    } catch (e) {
        $('#config-path').textContent = '获取失败';
    }

    $('#settings-modal').classList.add('active');

    // 绑定快捷键录入
    const hotkeyInput = $('#hotkey-input');
    hotkeyInput.addEventListener('focus', startRecordingHotkey);
    hotkeyInput.addEventListener('blur', stopRecordingHotkey);
}

function closeSettings() {
    $('#settings-modal').classList.remove('active');
    stopRecordingHotkey();
}

function startRecordingHotkey() {
    isRecordingHotkey = true;
    document.addEventListener('keydown', recordHotkey);
}

function stopRecordingHotkey() {
    isRecordingHotkey = false;
    document.removeEventListener('keydown', recordHotkey);
}

function recordHotkey(e) {
    if (!isRecordingHotkey) return;

    e.preventDefault();
    e.stopPropagation();

    // 忽略单独的修饰键
    const ignoredKeys = ['Control', 'Alt', 'Shift', 'Meta'];
    if (ignoredKeys.includes(e.key)) return;

    const parts = [];
    if (e.ctrlKey) parts.push('Ctrl');
    if (e.altKey) parts.push('Alt');
    if (e.shiftKey) parts.push('Shift');
    if (e.metaKey) parts.push('Super');

    // 转换按键名称
    let key = e.key;
    if (key === ' ') key = 'Space';
    else if (key.length === 1) key = key.toUpperCase();
    else if (key === 'ArrowUp') key = 'Up';
    else if (key === 'ArrowDown') key = 'Down';
    else if (key === 'ArrowLeft') key = 'Left';
    else if (key === 'ArrowRight') key = 'Right';

    parts.push(key);

    $('#hotkey-input').value = parts.join('+');
}

async function saveSettings() {
    const newHotkey = $('#hotkey-input').value;
    const newTheme = $('#theme-select').value;
    const newAutostart = $('#autostart-checkbox').checked;

    // 远程同步配置
    const newSyncEnabled = $('#sync-enabled-checkbox').checked;
    const newSyncServer = $('#sync-server').value.trim();
    const newSyncRemotePath = $('#sync-remote-path').value.trim();
    const newSyncPort = parseInt($('#sync-port').value) || 22;

    if (!newHotkey) {
        showToast('快捷键不能为空');
        return;
    }

    try {
        // 更新快捷键
        if (newHotkey !== config.hotkey) {
            await invoke('update_hotkey', { newHotkey });
            config.hotkey = newHotkey;
        }

        // 更新主题
        if (newTheme !== config.theme) {
            config.theme = newTheme;
            await invoke('save_config', { config });
            await invoke('set_window_theme', { theme: newTheme });
            applyTheme(newTheme);
        }

        // 更新开机自启
        if (newAutostart !== config.autostart) {
            await invoke('set_autostart', { enable: newAutostart });
            config.autostart = newAutostart;
        }

        // 更新远程同步配置
        config.remote_sync = {
            enabled: newSyncEnabled,
            server: newSyncServer,
            remote_path: newSyncRemotePath,
            port: newSyncPort
        };
        await invoke('save_config', { config });

        showToast('设置保存成功');
        closeSettings();
    } catch (e) {
        console.error(e);
        showToast('设置失败: ' + e);
    }
}

function escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
}

// ====== 远程同步功能 ======

// 打开同步模态框
function openSyncModal() {
    if (!config.remote_sync || !config.remote_sync.enabled) {
        showToast('请先在设置中启用远程同步');
        return;
    }
    if (!config.remote_sync.server || !config.remote_sync.remote_path) {
        showToast('请先配置服务器地址和远程路径');
        return;
    }
    if (!config.prompts_folder) {
        showToast('请先选择本地文件夹');
        return;
    }

    $('#sync-progress').classList.add('hidden');
    $('#sync-result').classList.add('hidden');
    $('#sync-pull-btn').disabled = false;
    $('#sync-push-btn').disabled = false;
    $('#sync-modal').classList.add('active');
}

// 关闭同步模态框
function closeSyncModal() {
    $('#sync-modal').classList.remove('active');
}

// 执行同步
async function doSync(direction) {
    const { server, remote_path, port } = config.remote_sync;

    $('#sync-pull-btn').disabled = true;
    $('#sync-push-btn').disabled = true;
    $('#sync-progress').classList.remove('hidden');
    $('#sync-result').classList.add('hidden');

    try {
        let result;
        if (direction === 'pull') {
            result = await invoke('sync_pull', {
                localFolder: config.prompts_folder,
                server,
                remotePath: remote_path,
                port: port || 22
            });
        } else {
            result = await invoke('sync_push', {
                localFolder: config.prompts_folder,
                server,
                remotePath: remote_path,
                port: port || 22
            });
        }

        $('#sync-progress').classList.add('hidden');
        $('#sync-result').textContent = result.message;
        $('#sync-result').className = 'sync-result success';

        // 同步成功后刷新列表
        await loadPrompts();
    } catch (e) {
        $('#sync-progress').classList.add('hidden');
        $('#sync-result').textContent = e;
        $('#sync-result').className = 'sync-result error';
    }

    $('#sync-pull-btn').disabled = false;
    $('#sync-push-btn').disabled = false;
}

// 切换同步设置的启用状态
function toggleSyncSettings() {
    const enabled = $('#sync-enabled-checkbox').checked;
    document.querySelectorAll('.sync-settings').forEach(el => {
        el.classList.toggle('disabled', !enabled);
    });
}

// 测试 SSH 连接
async function testSshConnection() {
    const server = $('#sync-server').value.trim();
    const port = parseInt($('#sync-port').value) || 22;
    const resultEl = $('#ssh-test-result');

    if (!server) {
        resultEl.textContent = '请输入服务器地址';
        resultEl.className = 'test-result error';
        return;
    }

    resultEl.textContent = '测试中...';
    resultEl.className = 'test-result';

    try {
        const result = await invoke('test_ssh_connection', { server, port });
        resultEl.textContent = result;
        resultEl.className = 'test-result success';
    } catch (e) {
        resultEl.textContent = e;
        resultEl.className = 'test-result error';
    }
}

// 检测 SSH 可用性
async function checkSshAvailable() {
    const statusEl = $('#ssh-status');
    try {
        const available = await invoke('check_ssh_available');
        if (available) {
            statusEl.textContent = '✓ SSH/SCP 可用';
            statusEl.className = 'ssh-status available';
        } else {
            statusEl.textContent = '✗ 未检测到 SSH/SCP，请安装 OpenSSH';
            statusEl.className = 'ssh-status unavailable';
        }
    } catch (e) {
        statusEl.textContent = '✗ 检测失败';
        statusEl.className = 'ssh-status unavailable';
    }
}
