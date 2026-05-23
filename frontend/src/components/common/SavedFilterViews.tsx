import { useEffect, useMemo, useState } from 'react'
import { Button, Dropdown, Empty, Input, Modal, Tag, Tooltip, message } from 'antd'
import { CheckOutlined, DeleteOutlined, DownOutlined, SaveOutlined, StarOutlined } from '@ant-design/icons'
import { savedFilterViewApi, type SavedFilterView } from '@/api/savedFilterViews'

type PresetFilterView<T> = {
  name: string
  filters: T
  note?: string
}

type SavedFilterViewsProps<T> = {
  storageKey: string
  currentFilters: T
  onApply: (filters: T) => void
  presets?: Array<PresetFilterView<T>>
  activeCount?: number
}

export default function SavedFilterViews<T extends object>({
  storageKey,
  currentFilters,
  onApply,
  presets = [],
  activeCount,
}: SavedFilterViewsProps<T>) {
  const [views, setViews] = useState<Array<SavedFilterView<T>>>([])
  const [loading, setLoading] = useState(false)
  const [saveOpen, setSaveOpen] = useState(false)
  const [dropdownOpen, setDropdownOpen] = useState(false)
  const [name, setName] = useState('')

  const hasViews = views.length > 0 || presets.length > 0
  const derivedActiveFilterCount = useMemo(
    () => Object.values(currentFilters).filter((value) => {
      if (Array.isArray(value)) return value.length > 0
      return Boolean(value)
    }).length,
    [currentFilters],
  )
  const activeFilterCount = activeCount ?? derivedActiveFilterCount

  const activeSignature = useMemo(() => filterSignature(currentFilters), [currentFilters])
  const activeViewLabel = useMemo(() => {
    const preset = presets.find((item) => filterSignature(item.filters) === activeSignature)
    if (preset) return preset.name
    const view = views.find((item) => filterSignature(item.filters) === activeSignature)
    return view?.name
  }, [activeSignature, presets, views])
  const isCurrentSaved = Boolean(activeViewLabel)
  const saveDisabledTip = activeViewLabel ? `当前筛选条件已是「${activeViewLabel}」` : ''

  const refreshViews = async () => {
    setLoading(true)
    try {
      setViews(await savedFilterViewApi.list<T>(storageKey))
    } catch {
      message.error('读取筛选视图失败')
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    void refreshViews()
  }, [storageKey])

  const handleSave = async () => {
    if (isCurrentSaved) {
      message.info(saveDisabledTip || '当前筛选条件已保存')
      return
    }
    const title = name.trim()
    if (!title) {
      message.warning('请输入视图名称')
      return
    }
    try {
      const saved = await savedFilterViewApi.save<T>(storageKey, title, currentFilters)
      setViews((prev) => [saved, ...prev.filter((item) => item.id !== saved.id && item.name !== saved.name)].slice(0, 30))
      setSaveOpen(false)
      setName('')
      message.success('筛选视图已保存')
    } catch (error: any) {
      message.error(error?.response?.data?.message || '保存筛选视图失败')
    }
  }

  const removeView = async (id: string) => {
    try {
      await savedFilterViewApi.delete(id)
      setViews((prev) => prev.filter((item) => item.id !== id))
      message.success('筛选视图已删除')
    } catch (error: any) {
      message.error(error?.response?.data?.message || '删除筛选视图失败')
    }
  }

  const applyView = (filters: T) => {
    onApply(filters)
    setDropdownOpen(false)
  }

  const dropdownContent = (
    <div className="atop-filter-view-panel">
      <div className="atop-filter-view-panel-head">
        <div>
          <strong>筛选视图</strong>
          <span>按当前账号保存，换设备后仍可用</span>
        </div>
        <Button
          size="small"
          className="atop-filter-view-save-btn"
          icon={<SaveOutlined />}
          disabled={isCurrentSaved}
          title={saveDisabledTip}
          onClick={() => {
            if (isCurrentSaved) return
            setDropdownOpen(false)
            setSaveOpen(true)
          }}
        >
          {isCurrentSaved ? '已保存' : '保存当前'}
        </Button>
      </div>

      {!hasViews ? (
        <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="暂无筛选视图" className="atop-filter-view-empty" />
      ) : (
        <div className="atop-filter-view-sections">
          {presets.length > 0 && (
            <div className="atop-filter-view-section">
              <div className="atop-filter-view-section-title">常用预设</div>
              {presets.map((preset) => {
                const active = filterSignature(preset.filters) === activeSignature
                return (
                  <button
                    key={preset.name}
                    type="button"
                    className={`atop-filter-view-option${active ? ' is-active' : ''}`}
                    onClick={() => applyView(preset.filters)}
                  >
                    <span>
                      <strong>{preset.name}</strong>
                      {preset.note && <small>{preset.note}</small>}
                    </span>
                    {active && <CheckOutlined />}
                  </button>
                )
              })}
            </div>
          )}

          {views.length > 0 && (
            <div className="atop-filter-view-section">
              <div className="atop-filter-view-section-title">我的视图</div>
              {views.map((view) => {
                const active = filterSignature(view.filters) === activeSignature
                return (
                  <div key={view.id} className={`atop-filter-view-option-row${active ? ' is-active' : ''}`}>
                    <button type="button" className="atop-filter-view-option" onClick={() => applyView(view.filters)}>
                      <span>
                        <strong>{view.name}</strong>
                        <small>{new Date(view.createdAt).toLocaleString()}</small>
                      </span>
                      {active && <CheckOutlined />}
                    </button>
                    <Tooltip title="删除视图">
                      <Button size="small" type="text" danger icon={<DeleteOutlined />} onClick={() => removeView(view.id)} />
                    </Tooltip>
                  </div>
                )
              })}
            </div>
          )}
        </div>
      )}
    </div>
  )

  return (
    <>
      <div className="atop-filter-view-actions">
        <Dropdown
          open={dropdownOpen}
          onOpenChange={setDropdownOpen}
          dropdownRender={() => dropdownContent}
          trigger={['click']}
          placement="bottomRight"
        >
          <Button icon={<StarOutlined />} loading={loading}>
            {activeViewLabel || '筛选视图'}
            <DownOutlined />
          </Button>
        </Dropdown>
        <Tooltip title={saveDisabledTip}>
          <Button
            className="atop-filter-view-save-trigger"
            icon={<SaveOutlined />}
            disabled={isCurrentSaved}
            onClick={() => {
              if (!isCurrentSaved) setSaveOpen(true)
            }}
          >
            {isCurrentSaved ? '已保存' : '保存当前'}
            {activeFilterCount > 0 && <Tag color={isCurrentSaved ? 'default' : 'blue'}>{activeFilterCount}</Tag>}
          </Button>
        </Tooltip>
      </div>

      <Modal
        title="保存筛选视图"
        open={saveOpen}
        onCancel={() => setSaveOpen(false)}
        onOk={handleSave}
        okText="保存"
        cancelText="取消"
        okButtonProps={{ disabled: isCurrentSaved }}
      >
        {isCurrentSaved && (
          <div className="atop-filter-view-saved-hint">
            当前条件已匹配「{activeViewLabel}」，无需重复保存。
          </div>
        )}
        <Input
          autoFocus
          value={name}
          onChange={(event) => setName(event.target.value)}
          onPressEnter={handleSave}
          placeholder="例如：今天失败运行 / 我负责的流水线 / 高风险审计操作"
          maxLength={40}
          showCount
        />
        {views.length > 0 && (
          <div className="atop-filter-view-list">
            {views.map((view) => (
              <div key={view.id}>
                <span>{view.name}</span>
                <Button size="small" type="text" danger icon={<DeleteOutlined />} onClick={() => removeView(view.id)} />
              </div>
            ))}
          </div>
        )}
      </Modal>
    </>
  )
}

function isEmptyFilterValue(value: unknown) {
  if (Array.isArray(value)) return value.length === 0
  return value === undefined || value === null || value === ''
}

function normalizeFilterValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(normalizeFilterValue)
  if (value && typeof value === 'object') return normalizeFilterObject(value as Record<string, unknown>)
  return value
}

function normalizeFilterObject(value: Record<string, unknown>) {
  return Object.keys(value)
    .sort()
    .reduce<Record<string, unknown>>((acc, key) => {
      const item = value[key]
      if (!isEmptyFilterValue(item)) {
        acc[key] = normalizeFilterValue(item)
      }
      return acc
    }, {})
}

function filterSignature(value: object) {
  return JSON.stringify(normalizeFilterObject(value as Record<string, unknown>))
}
