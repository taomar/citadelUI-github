export function createDocumentActions({ views, currentOwner, setStatus }) {
  function captureDocumentAction(owner = currentOwner()) {
    return { owner, document: owner.current, contract: owner.contract,
      generation: owner.documentGeneration, ticket: views.ticket() };
  }

  function ownsDocumentAction(action) {
    return currentOwner() === action.owner && views.isCurrent(action.ticket) &&
      action.owner.current === action.document && action.owner.contract === action.contract &&
      action.owner.documentGeneration === action.generation;
  }

  function retainDocumentNotice(action, message, tone, outcome = false) {
    const { owner, document, contract, generation } = action;
    const path = document?.path || contract?.policy?.path;
    const notice = { message, tone, outcome };
    if (path) {
      owner.documentNotices ||= new Map();
      // A reload error must not erase a confirmed source outcome awaiting its owner.
      if (outcome || !owner.documentNotices.get(path)?.outcome) owner.documentNotices.set(path, notice);
    }
    if (owner.current === document && owner.contract === contract && owner.documentGeneration === generation) {
      owner.status = notice;
    }
    if (ownsDocumentAction(action)) setStatus(message, tone);
  }

  function restoreDocumentNotice() {
    const owner = currentOwner();
    const path = owner.current?.path, notice = owner.documentNotices?.get(path);
    if (!notice) return;
    owner.documentNotices.delete(path);
    setStatus(notice.message, notice.tone);
  }

  return { captureDocumentAction, ownsDocumentAction, retainDocumentNotice, restoreDocumentNotice };
}
