// stub — Task 18 replaces this
export function ApprovalCard({
  slug, request
}: {
  slug: string
  request: { requestId: string; tool: string; risk: string; argsPreview: string; grantKey: string | null }
}): React.JSX.Element {
  return <div className="text-xs text-defect">approval pending: {request.tool} ({slug})</div>
}
