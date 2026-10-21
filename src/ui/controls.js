'use strict';

// Keep the native select as the data/API surface; only its presentation is enhanced.
(() => {
  if (!('showPopover' in HTMLElement.prototype)) return;
  const controls = new Map();
  let serial = 0;
  let opened = null;
  let scheduled = false;
  const setAttribute = (element, name, value) => {
    if (value === null) {
      if (element.hasAttribute(name)) element.removeAttribute(name);
    } else if (element.getAttribute(name) !== String(value))
      element.setAttribute(name, String(value));
  };
  const optionHidden = (option) =>
    option.hidden || (option.parentElement?.tagName === 'OPTGROUP' && option.parentElement.hidden);
  const optionDisabled = (option) =>
    option.disabled ||
    (option.parentElement?.tagName === 'OPTGROUP' && option.parentElement.disabled);

  function enhance(select) {
    if (controls.has(select)) return;
    const id = `album-select-${++serial}`;
    const wrapper = document.createElement('span');
    wrapper.className = 'album-select';
    const button = document.createElement('button');
    button.type = 'button';
    button.id = `${id}-button`;
    button.className = 'album-select-button';
    button.setAttribute('role', 'combobox');
    button.setAttribute('aria-haspopup', 'listbox');
    button.setAttribute('aria-expanded', 'false');
    button.setAttribute('aria-controls', `${id}-list`);
    const text = document.createElement('span');
    text.className = 'album-select-value';
    const chevron = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    chevron.setAttribute('viewBox', '0 0 24 24');
    chevron.setAttribute('aria-hidden', 'true');
    const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    path.setAttribute('d', 'm7 10 5 5 5-5');
    chevron.append(path);
    button.append(text, chevron);
    const list = document.createElement('div');
    list.id = `${id}-list`;
    list.className = 'album-select-list';
    list.setAttribute('role', 'listbox');
    list.setAttribute('popover', 'manual');
    select.before(wrapper);
    wrapper.append(select, button, list);
    select.classList.add('album-select-source');
    select.setAttribute('aria-hidden', 'true');
    const originalTabIndex = select.getAttribute('tabindex');
    select.tabIndex = -1;
    let signature = '';
    let items = [];
    let active = -1;
    let search = '';
    let searchTime = 0;
    let disposed = false;
    const controller = new AbortController();
    const listen = (target, event, handler, options = {}) =>
      target.addEventListener(event, handler, { ...options, signal: controller.signal });
    const enabled = () =>
      [...select.options]
        .map((o, i) => (!optionDisabled(o) && !optionHidden(o) ? i : -1))
        .filter((i) => i >= 0);
    const isOpen = () => opened === control;
    function close() {
      if (!isOpen()) return;
      opened = null;
      if (list.matches(':popover-open')) list.hidePopover();
      setAttribute(button, 'aria-expanded', 'false');
      setAttribute(button, 'aria-activedescendant', null);
      search = '';
    }
    function position() {
      if (!isOpen()) return;
      const rect = button.getBoundingClientRect();
      if (!button.isConnected || !button.getClientRects().length || button.disabled) {
        close();
        return;
      }
      const gutter = 8;
      const width = Math.min(Math.max(rect.width, list.scrollWidth, 144), innerWidth - gutter * 2);
      const below = Math.max(0, innerHeight - rect.bottom - gutter - 6);
      const above = Math.max(0, rect.top - gutter - 6);
      const upwards = below < Math.min(list.scrollHeight, 240) && above > below;
      const height = Math.min(320, upwards ? above : below);
      list.style.width = `${width}px`;
      list.style.maxHeight = `${height}px`;
      list.style.left = `${Math.max(gutter, Math.min(rect.left, innerWidth - width - gutter))}px`;
      list.style.top = `${upwards ? Math.max(gutter, rect.top - Math.min(list.scrollHeight, height) - 6) : rect.bottom + 6}px`;
    }
    function highlight(index) {
      active = index;
      items.forEach((item, i) => item.classList.toggle('is-active', i === active));
      setAttribute(button, 'aria-activedescendant', active >= 0 ? `${id}-option-${active}` : null);
      items[active]?.scrollIntoView({ block: 'nearest' });
    }
    function open(index = select.selectedIndex) {
      refresh();
      if (button.disabled || wrapper.hidden) return;
      if (opened && opened !== control) opened.close();
      if (!isOpen()) {
        opened = control;
        list.showPopover();
        setAttribute(button, 'aria-expanded', 'true');
      }
      position();
      const available = enabled();
      highlight(available.includes(index) ? index : (available[0] ?? -1));
    }
    function choose(index) {
      const option = select.options[index];
      if (!option || optionDisabled(option)) return;
      const previous = select.value;
      const previousIndex = select.selectedIndex;
      select.selectedIndex = index;
      close();
      refresh();
      if (previous !== select.value || previousIndex !== select.selectedIndex) {
        select.dispatchEvent(new Event('input', { bubbles: true }));
        select.dispatchEvent(new Event('change', { bubbles: true }));
      }
    }
    function refresh() {
      if (disposed || !select.isConnected) return;
      wrapper.hidden = select.hidden;
      button.disabled = select.matches(':disabled');
      button.tabIndex = originalTabIndex === null ? 0 : Number(originalTabIndex);
      wrapper.classList.toggle('album-select-field', select.classList.contains('field-input'));
      setAttribute(button, 'title', select.title || null);
      setAttribute(button, 'aria-required', select.required ? 'true' : null);
      for (const attribute of ['aria-describedby', 'aria-invalid', 'aria-errormessage'])
        setAttribute(button, attribute, select.getAttribute(attribute));
      const labels = [...select.labels];
      const labelledBy = select.getAttribute('aria-labelledby');
      if (labelledBy) {
        setAttribute(button, 'aria-labelledby', labelledBy);
        setAttribute(button, 'aria-label', null);
      } else {
        // Use label text without the selected value inside a wrapping label.
        const label =
          select.getAttribute('aria-label') ||
          labels
            .map((label) => {
              const clone = label.cloneNode(true);
              clone.querySelectorAll('select, .album-select').forEach((node) => node.remove());
              return clone.textContent.trim();
            })
            .filter(Boolean)
            .join(' ') ||
          select.closest('.setting-row')?.querySelector('strong')?.textContent ||
          '选择选项';
        setAttribute(button, 'aria-label', label);
        setAttribute(button, 'aria-labelledby', null);
      }
      setAttribute(list, 'aria-label', button.getAttribute('aria-label'));
      setAttribute(list, 'aria-labelledby', labelledBy);
      const options = [...select.options];
      const nextSignature = JSON.stringify(
        options.map((option) => [
          option.label,
          option.value,
          optionDisabled(option),
          optionHidden(option),
          option.parentElement?.label
        ])
      );
      if (signature !== nextSignature) {
        signature = nextSignature;
        items = options.map((option, index) => {
          const item = document.createElement('div');
          item.id = `${id}-option-${index}`;
          item.className = 'album-select-option';
          item.setAttribute('role', 'option');
          item.dataset.index = index;
          item.textContent = option.label;
          item.hidden = optionHidden(option);
          setAttribute(item, 'aria-disabled', optionDisabled(option) ? 'true' : null);
          if (option.parentElement?.tagName === 'OPTGROUP') item.title = option.parentElement.label;
          return item;
        });
        list.replaceChildren(...items);
      }
      const label =
        select.selectedOptions[0]?.label || select.getAttribute('data-placeholder') || '请选择';
      if (text.textContent !== label) text.textContent = label;
      items.forEach((item, index) =>
        setAttribute(item, 'aria-selected', index === select.selectedIndex)
      );
      if (isOpen()) {
        if (button.disabled || wrapper.hidden) close();
        else {
          const available = enabled();
          highlight(available.includes(active) ? active : (available[0] ?? -1));
          position();
        }
      }
    }
    const control = {
      select,
      wrapper,
      button,
      list,
      refresh,
      close,
      position,
      dispose() {
        close();
        disposed = true;
        controller.abort();
        observer.disconnect();
        controls.delete(select);
      }
    };
    controls.set(select, control);
    // DOM properties do not emit mutation records. Delegate to the original setters
    // and synchronise immediately, preserving select.value/selectedIndex APIs.
    for (const name of ['value', 'selectedIndex']) {
      const descriptor = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, name);
      Object.defineProperty(select, name, {
        configurable: true,
        get() {
          return descriptor.get.call(this);
        },
        set(value) {
          descriptor.set.call(this, value);
          refresh();
        }
      });
    }
    const observer = new MutationObserver(refresh);
    observer.observe(select, {
      attributes: true,
      childList: true,
      characterData: true,
      subtree: true
    });
    listen(select, 'input', refresh);
    listen(select, 'change', refresh);
    listen(button, 'click', () => (isOpen() ? close() : open()));
    listen(button, 'keydown', (event) => {
      if (
        event.ctrlKey ||
        event.metaKey ||
        (event.altKey && !['ArrowDown', 'ArrowUp'].includes(event.key))
      )
        return;
      const available = enabled();
      if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) {
        event.preventDefault();
        event.stopPropagation();
        let index = select.selectedIndex;
        if (event.key === 'Home') index = available[0];
        else if (event.key === 'End') index = available.at(-1);
        else if (isOpen()) {
          const current = available.indexOf(active);
          index =
            available[
              Math.max(
                0,
                Math.min(available.length - 1, current + (event.key === 'ArrowDown' ? 1 : -1))
              )
            ];
        }
        open(index);
      } else if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault();
        event.stopPropagation();
        if (isOpen()) choose(active);
        else open();
      } else if (event.key === 'Tab') close();
      else if (event.key.length === 1 && !event.altKey) {
        event.preventDefault();
        const now = performance.now();
        search = now - searchTime > 700 ? event.key : search + event.key;
        searchTime = now;
        const query = [...search].every((char) => char === search[0]) ? search[0] : search;
        const current = isOpen() ? active : select.selectedIndex;
        const start = query.length === 1 ? current + 1 : Math.max(0, current);
        const ordered = [
          ...available.filter((i) => i >= start),
          ...available.filter((i) => i < start)
        ];
        const index = ordered.find((i) =>
          select.options[i].label.trim().toLocaleLowerCase().startsWith(query.toLocaleLowerCase())
        );
        if (index !== undefined) {
          if (isOpen()) highlight(index);
          else {
            const buffer = search;
            choose(index);
            search = buffer;
          }
        }
      }
    });
    listen(list, 'pointerdown', (event) => {
      if (event.button === 0) event.preventDefault();
    });
    listen(list, 'pointermove', (event) => {
      const item = event.target.closest('[data-index]');
      if (
        item &&
        Number(item.dataset.index) !== active &&
        item.getAttribute('aria-disabled') !== 'true'
      )
        highlight(Number(item.dataset.index));
    });
    listen(list, 'click', (event) => {
      event.preventDefault();
      const item = event.target.closest('[data-index]');
      if (item) choose(Number(item.dataset.index));
    });
    listen(select, 'invalid', (event) => {
      event.preventDefault();
      button.focus();
      setAttribute(button, 'aria-invalid', 'true');
    });
    refresh();
  }

  function scan() {
    scheduled = false;
    for (const control of controls.values()) {
      if (!control.select.isConnected) control.dispose();
      else control.refresh();
    }
    document.querySelectorAll('select').forEach(enhance);
  }
  function scheduleScan() {
    if (scheduled) return;
    scheduled = true;
    queueMicrotask(scan);
  }
  // Option.selected is also used by automation and existing editor code.
  const selected = Object.getOwnPropertyDescriptor(HTMLOptionElement.prototype, 'selected');
  Object.defineProperty(HTMLOptionElement.prototype, 'selected', {
    ...selected,
    set(value) {
      selected.set.call(this, value);
      controls.get(this.closest('select'))?.refresh();
    }
  });
  const observer = new MutationObserver((records) => {
    if (
      records.some((record) => {
        const element =
          record.target.nodeType === Node.ELEMENT_NODE
            ? record.target
            : record.target.parentElement;
        if (!element) return false;
        const select = element.closest('select');
        // Enhanced selects already observe their own attributes, options and text.
        if (select) return !controls.has(select);
        if (
          record.type === 'childList' &&
          [...record.addedNodes, ...record.removedNodes].some(
            (node) =>
              node.nodeType === Node.ELEMENT_NODE &&
              (node.matches('select, .album-select, label') ||
                node.querySelector('select, .album-select, label'))
          )
        )
          return true;
        // Ignore the presentation mutations produced by refresh() itself.
        if (element.closest('.album-select')) return false;
        if (record.type === 'attributes')
          return (
            element.matches('label') ||
            (['disabled', 'hidden', 'open'].includes(record.attributeName) &&
              Boolean(element.querySelector('select')))
          );
        return Boolean(
          element.closest('label') || element.closest('.setting-row')?.querySelector('select')
        );
      })
    )
      scheduleScan();
  });
  observer.observe(document.body, {
    childList: true,
    characterData: true,
    subtree: true,
    attributes: true,
    attributeFilter: [
      'for',
      'disabled',
      'hidden',
      'open',
      'aria-label',
      'aria-labelledby',
      'aria-describedby',
      'aria-invalid'
    ]
  });
  document.addEventListener(
    'pointerdown',
    (event) => {
      if (opened && !opened.wrapper.contains(event.target)) opened.close();
    },
    true
  );
  document.addEventListener('focusin', (event) => {
    if (opened && event.target !== opened.button && !opened.list.contains(event.target))
      opened.close();
  });
  document.addEventListener(
    'keydown',
    (event) => {
      if (opened && event.key === 'Escape') {
        event.preventDefault();
        event.stopImmediatePropagation();
        opened.close();
      }
    },
    true
  );
  // Closing a dialog may hide it before the mutation observer runs.
  document.addEventListener('close', () => opened?.close(), true);
  document.addEventListener(
    'cancel',
    (event) => {
      if (opened) {
        event.preventDefault();
        opened.close();
      }
    },
    true
  );
  document.addEventListener('click', (event) => {
    const label = event.target.closest('label');
    const control = label?.control && controls.get(label.control);
    if (control && !event.target.closest('button, input, a, .album-select-list')) {
      event.preventDefault();
      control.button.focus();
    }
  });
  document.addEventListener('reset', scheduleScan, true);
  document.addEventListener('scroll', () => opened?.position(), true);
  window.addEventListener('resize', () => opened?.position());
  window.addEventListener(
    'pagehide',
    () => {
      observer.disconnect();
      for (const control of controls.values()) control.dispose();
    },
    { once: true }
  );
  window.albumControls = { refresh: scan };
  scan();
})();
