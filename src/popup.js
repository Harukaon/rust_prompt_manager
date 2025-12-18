// 快速插入弹窗逻辑
const { invoke } = window.__TAURI__.core;

let items = [];
let selectedIndex = 0;

async function init() {
    try {
        // 加载配置并应用主题
        const config = await invoke('get_config');
        document.documentElement.setAttribute('data-theme', config.theme || 'dark');

        items = await invoke('get_all_mnemonics');
    } catch (e) {
        console.error('加载助记词失败:', e);
        items = [];
    }
    renderList(items);

    // 搜索过滤（支持标题、助记词、内容全文检索）
    document.getElementById('search').addEventListener('input', (e) => {
        const query = e.target.value.toLowerCase();
        const filtered = items.filter(item =>
            item.mnemonic.toLowerCase().includes(query) ||
            item.title.toLowerCase().includes(query) ||
            item.content.toLowerCase().includes(query)
        );
        selectedIndex = 0;
        renderList(filtered);
    });

    // 键盘导航
    document.addEventListener('keydown', async (e) => {
        const listItems = document.querySelectorAll('.list-item');

        if (e.key === 'ArrowDown') {
            e.preventDefault();
            selectedIndex = Math.min(selectedIndex + 1, listItems.length - 1);
            updateSelection(listItems);
        } else if (e.key === 'ArrowUp') {
            e.preventDefault();
            selectedIndex = Math.max(selectedIndex - 1, 0);
            updateSelection(listItems);
        } else if (e.key === 'Enter') {
            e.preventDefault();
            const selectedItem = listItems[selectedIndex];
            if (selectedItem) {
                const content = contentMap.get(selectedItem.dataset.index);
                if (content) {
                    await insertContent(content);
                }
            }
        } else if (e.key === 'Escape') {
            await invoke('hide_popup');
        }
    });

    // 窗口失焦时隐藏
    window.addEventListener('blur', async () => {
        await invoke('hide_popup');
    });

    // 窗口获得焦点时重新加载数据（确保内容实时）
    window.addEventListener('focus', async () => {
        try {
            items = await invoke('get_all_mnemonics');
            // 清空搜索框并重新渲染
            document.getElementById('search').value = '';
            selectedIndex = 0;
            renderList(items);
        } catch (e) {
            console.error('刷新数据失败:', e);
        }
    });

    // 模拟输入剪切板内容按钮
    document.getElementById('paste-clipboard-btn').addEventListener('click', async () => {
        try {
            const clipboardText = await invoke('read_clipboard');
            if (clipboardText) {
                await invoke('hide_popup');
                await new Promise(r => setTimeout(r, 100));
                await invoke('type_text_simulate', { text: clipboardText });
            }
        } catch (e) {
            console.error('模拟输入剪切板失败:', e);
        }
    });
}

// 存储完整内容的映射
let contentMap = new Map();

function renderList(data) {
    const list = document.getElementById('list');
    contentMap.clear();

    if (data.length === 0) {
        list.innerHTML = '<div class="empty">暂无助记词</div>';
        return;
    }

    // 存储内容到 Map 中，避免 HTML 属性转义问题
    data.forEach((item, index) => {
        contentMap.set(index.toString(), item.content);
    });

    list.innerHTML = data.map((item, index) => `
        <div class="list-item ${index === selectedIndex ? 'selected' : ''}"
             data-index="${index}">
            <div>
                <span class="mnemonic">${escapeHtml(item.mnemonic)}</span>
                <span class="title">${escapeHtml(item.title)}</span>
            </div>
            <div class="preview">${escapeHtml(item.content.substring(0, 50))}...</div>
        </div>
    `).join('');

    // 点击事件
    list.querySelectorAll('.list-item').forEach(el => {
        el.addEventListener('click', async () => {
            const content = contentMap.get(el.dataset.index);
            if (content) {
                await insertContent(content);
            }
        });
    });
}

function updateSelection(listItems) {
    listItems.forEach((el, i) => {
        el.classList.toggle('selected', i === selectedIndex);
    });
    // 滚动到可见
    listItems[selectedIndex]?.scrollIntoView({ block: 'nearest' });
}

async function insertContent(content) {
    try {
        // 检查是否使用模拟输入模式
        const useSimulate = document.getElementById('simulate-mode')?.checked || false;

        // 先隐藏窗口
        await invoke('hide_popup');

        // 等待一下让焦点回到原窗口
        await new Promise(r => setTimeout(r, 100));

        // 根据模式选择输入方式
        if (useSimulate) {
            await invoke('type_text_simulate', { text: content });
        } else {
            await invoke('type_text', { text: content });
        }
    } catch (e) {
        console.error('插入失败:', e);
    }
}

function escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
}

// 禁用右键菜单
document.addEventListener('contextmenu', (e) => e.preventDefault());

window.addEventListener('DOMContentLoaded', init);
