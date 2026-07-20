import { Component, For, Show } from 'solid-js';
import { A } from '@solidjs/router';

export interface Crumb {
  label: string;
  href?: string;
}

const Breadcrumbs: Component<{ items: Crumb[] }> = (props) => {
  return (
    <nav class="breadcrumbs" aria-label="Breadcrumb">
      <For each={props.items}>
        {(crumb, i) => (
          <>
            <Show when={i() > 0}>
              <span class="breadcrumb-sep">
                <span class="material-symbols-outlined" style="font-size:1rem;">chevron_right</span>
              </span>
            </Show>
            <Show
              when={crumb.href}
              fallback={<span class="breadcrumb-current">{crumb.label}</span>}
            >
              <A href={crumb.href!} class="breadcrumb-link">{crumb.label}</A>
            </Show>
          </>
        )}
      </For>
    </nav>
  );
};

export default Breadcrumbs;
