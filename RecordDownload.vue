<!--
  海康 NVR 录像区间下载 —— Vue 3 组件

  前提：后端代理已在跑（hik_server.py），Vue 通过 /api 访问它。

  vite.config.js 里加代理（开发环境）：
    server: {
      proxy: {
        '/api': { target: 'http://127.0.0.1:8000', changeOrigin: true }
      }
    }

  生产环境则用 Nginx 把 /api 反代到后端，或直接部署在同域下。
  只要前端和后端同源，跨域、Digest、混合内容这三个问题就全部消失。
-->
<template>
  <div class="hik-download">
    <h3>录像下载</h3>

    <div class="field">
      <label>通道</label>
      <input v-model.number="form.channel" type="number" min="1" max="64" />
    </div>

    <div class="field">
      <label>开始时间</label>
      <input v-model="form.start" type="datetime-local" step="1" />
    </div>

    <div class="field">
      <label>结束时间</label>
      <input v-model="form.end" type="datetime-local" step="1" />
    </div>

    <div class="field">
      <label>码流</label>
      <select v-model="form.stream">
        <option value="main">主码流（高清，文件大）</option>
        <option value="sub">子码流（省流量，画质低）</option>
      </select>
    </div>

    <div class="actions">
      <button :disabled="busy" @click="onSearch">
        {{ searching ? '查询中…' : '查询录像' }}
      </button>
      <button :disabled="busy || !segments.length" @click="onDownload">
        {{ downloading ? '下载中…' : '下载 MP4' }}
      </button>
    </div>

    <p v-if="msg" :class="['msg', msgType]">{{ msg }}</p>

    <ul v-if="segments.length" class="segs">
      <li v-for="(s, i) in segments" :key="i">
        <span class="idx">{{ i + 1 }}</span>
        {{ s.start }} → {{ s.end }}
      </li>
    </ul>
  </div>
</template>

<script setup>
import { ref, reactive, computed } from 'vue'

const API = '/api'

const form = reactive({
  channel: 1,
  start: '',
  end: '',
  stream: 'main',
})

const segments = ref([])
const msg = ref('')
const msgType = ref('info')
const searching = ref(false)
const downloading = ref(false)

const busy = computed(() => searching.value || downloading.value)

/** datetime-local 的值是 "2026-10-15T08:00:00"，后端要 "2026-10-15 08:00:00" */
function normalize(v) {
  return (v || '').replace('T', ' ')
}

function setMsg(text, type = 'info') {
  msg.value = text
  msgType.value = type
}

async function onSearch() {
  if (!form.start || !form.end) {
    setMsg('先把开始和结束时间填上', 'error')
    return
  }
  searching.value = true
  segments.value = []
  setMsg('正在查询录像段…')

  try {
    const q = new URLSearchParams({
      channel: form.channel,
      start: normalize(form.start),
      end: normalize(form.end),
      stream: form.stream,
    })
    const res = await fetch(`${API}/records?${q}`)
    const data = await res.json()

    if (!data.ok) throw new Error(data.error || '查询失败')

    segments.value = data.segments || []
    if (segments.value.length) {
      setMsg(`找到 ${segments.value.length} 段录像，共 ${durationText()}`, 'ok')
    } else {
      setMsg('该时间段没有录像', 'error')
    }
  } catch (e) {
    setMsg(`查询失败：${e.message}`, 'error')
  } finally {
    searching.value = false
  }
}

function durationText() {
  const total = segments.value.reduce((acc, s) => {
    const a = new Date(s.start)
    const b = new Date(s.end)
    return acc + Math.max(0, (b - a) / 1000)
  }, 0)
  const h = Math.floor(total / 3600)
  const m = Math.round((total % 3600) / 60)
  return h ? `${h} 小时 ${m} 分` : `${m} 分钟`
}

async function onDownload() {
  downloading.value = true
  setMsg('后端正在下载并转码，长区间可能要等几分钟…')

  try {
    const res = await fetch(`${API}/download`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        channel: form.channel,
        start: normalize(form.start),
        end: normalize(form.end),
        stream: form.stream,
      }),
    })
    const data = await res.json()
    if (!data.ok) throw new Error(data.error || '下载失败')

    setMsg(`已生成 ${data.file}（${(data.size / 1048576).toFixed(1)} MB），开始保存…`, 'ok')

    // 用浏览器原生下载，不把整个文件读进内存
    const a = document.createElement('a')
    a.href = `${API}/file?name=${encodeURIComponent(data.file)}`
    a.download = data.file
    document.body.appendChild(a)
    a.click()
    a.remove()
  } catch (e) {
    setMsg(`下载失败：${e.message}`, 'error')
  } finally {
    downloading.value = false
  }
}
</script>

<style scoped>
.hik-download {
  max-width: 460px;
  font-size: 14px;
}
.field {
  display: flex;
  align-items: center;
  gap: 12px;
  margin-bottom: 10px;
}
.field label {
  width: 68px;
  flex: none;
  color: #888;
}
.field input,
.field select {
  flex: 1;
  padding: 6px 8px;
  border: 1px solid #3a4250;
  border-radius: 6px;
  background: transparent;
  color: inherit;
  font: inherit;
}
.actions {
  display: flex;
  gap: 10px;
  margin: 14px 0;
}
.actions button {
  padding: 7px 16px;
  border: 1px solid #3a4250;
  border-radius: 6px;
  background: transparent;
  color: inherit;
  font: inherit;
  cursor: pointer;
}
.actions button:disabled {
  opacity: 0.45;
  cursor: not-allowed;
}
.msg {
  margin: 8px 0;
  line-height: 1.6;
}
.msg.error { color: #E24B4A; }
.msg.ok { color: #4ade80; }
.msg.info { color: #888; }
.segs {
  margin: 10px 0 0;
  padding: 0;
  list-style: none;
  max-height: 200px;
  overflow: auto;
}
.segs li {
  padding: 5px 0;
  border-bottom: 1px solid #2a3140;
  color: #aaa;
  font-family: ui-monospace, monospace;
  font-size: 12px;
}
.idx {
  display: inline-block;
  width: 26px;
  color: #666;
}
</style>
