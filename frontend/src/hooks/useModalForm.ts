import { useRef, useCallback } from 'react'
import type { FormInstance } from 'antd'
import { formSnapshot, hasFormChanged } from '@/utils/formDirty'

/**
 * Unified modal form hook:
 * - tracks dirty state by comparing against the opening snapshot
 * - provides a cancelWithConfirm helper that shows confirm when dirty
 * - provides an AbortController for cancelling in-flight requests on close
 */
export function useModalForm(form: FormInstance) {
  const abortRef = useRef<AbortController | null>(null)
  const initialSnapshotRef = useRef('')

  const newAbort = useCallback(() => {
    // Cancel any previous in-flight request
    abortRef.current?.abort()
    abortRef.current = new AbortController()
    return abortRef.current.signal
  }, [])

  const cancelRequest = useCallback(() => {
    abortRef.current?.abort()
    abortRef.current = null
  }, [])

  const isDirty = useCallback(() => {
    if (!initialSnapshotRef.current) return form.isFieldsTouched()
    return hasFormChanged(initialSnapshotRef.current, form.getFieldsValue(true))
  }, [form])

  const markClean = useCallback((values?: unknown) => {
    initialSnapshotRef.current = formSnapshot(values ?? form.getFieldsValue(true))
  }, [form])

  /**
   * Call this instead of directly closing the modal.
   * If the form is dirty, shows a confirm dialog first.
   */
  const cancelWithConfirm = useCallback((onClose: () => void) => {
    const dirty = initialSnapshotRef.current
      ? hasFormChanged(initialSnapshotRef.current, form.getFieldsValue(true))
      : form.isFieldsTouched()
    if (!dirty) {
      cancelRequest()
      onClose()
      return
    }
    import('antd').then(({ Modal }) => {
      Modal.confirm({
        title: '确认放弃修改？',
        content: '当前有未保存的修改，关闭后将丢失。',
        okText: '放弃修改',
        cancelText: '继续编辑',
        okButtonProps: { danger: true },
        onOk: () => {
          cancelRequest()
          onClose()
        },
      })
    })
  }, [form, cancelRequest])

  return { isDirty, markClean, cancelWithConfirm, newAbort, cancelRequest }
}
