import type { ReactElement } from "react";
import { DeviceRowsSkeleton } from "./device-management-dialog.js";
import { UpdatePageSkeleton } from "../UpdatePage.js";

type AccountSkeletonView = "home" | "profile" | "appearance" | "archives" | "updates";

export function AccountPageSkeleton(props: { readonly view: AccountSkeletonView }): ReactElement {
  if (props.view === "archives") return <AccountArchivePageSkeleton />;
  if (props.view === "profile") return <AccountProfileSkeleton />;
  if (props.view === "updates") return <UpdatePageSkeleton />;
  if (props.view === "appearance") return <AccountAppearanceSkeleton />;

  return (
    <div className="account-skeleton-overview" aria-hidden="true">
      <span className="skeleton-block account-skeleton-connection" />
      <section className="detail-panel account-skeleton-panel">
        <div className="account-skeleton-panel-heading">
          <span className="skeleton-block account-skeleton-section-title" />
          <span className="skeleton-block account-skeleton-icon-large" />
        </div>
        <div className="account-skeleton-device-line">
          <span className="skeleton-block account-skeleton-device-icon" />
          <span className="skeleton-block account-skeleton-value" />
        </div>
        <span className="skeleton-block account-skeleton-detail-line" />
        <DeviceRowsSkeleton />
      </section>
      <section className="legacy-import-panel account-skeleton-panel">
        <div className="account-skeleton-panel-heading">
          <span className="skeleton-block account-skeleton-icon-large" />
          <span className="skeleton-block account-skeleton-section-title" />
        </div>
        <span className="skeleton-block account-skeleton-copy" />
        <div className="account-skeleton-count-grid">
          {Array.from({ length: 10 }, (_, index) => (
            <span className="skeleton-block account-skeleton-count" key={index} />
          ))}
        </div>
      </section>
    </div>
  );
}

export function AccountProfileSkeleton(): ReactElement {
  return (
    <div className="account-profile-page-skeleton" aria-busy="true">
      <div className="account-profile-stack" aria-hidden="true">
        <section className="profile-card">
          <div className="profile-edit-form">
            <div className="profile-avatar-row">
              <span className="skeleton-block account-skeleton-profile-avatar" />
            </div>
            <span className="skeleton-block account-skeleton-profile-name" />
            <span className="skeleton-block account-skeleton-profile-email" />
          </div>
        </section>

        <div className="account-center-sections">
          <section className="account-center-section">
            <div className="account-center-heading">
              <span className="skeleton-block account-skeleton-section-title" />
              <span className="skeleton-block account-profile-skeleton-action" />
            </div>
            <AccountProfileRecentWorkSkeleton />
          </section>

          <section className="account-center-section">
            <div className="account-center-heading">
              <span className="skeleton-block account-skeleton-section-title" />
            </div>
            <AccountProfileUsageSkeleton />
            <div className="account-center-row account-profile-skeleton-model-row">
              <div className="account-center-row-copy">
                <span className="skeleton-block account-profile-skeleton-model-label" />
              </div>
              <span className="skeleton-block account-profile-skeleton-action" />
            </div>
          </section>

          <section className="account-center-section">
            <div className="account-center-heading">
              <span className="skeleton-block account-skeleton-section-title" />
            </div>
            <div className="account-center-row">
              <div className="account-center-row-copy">
                <span className="skeleton-block account-profile-skeleton-row-title" />
                <span className="skeleton-block account-profile-skeleton-row-detail" />
              </div>
              <span className="skeleton-block account-profile-skeleton-action" />
            </div>
            <div className="account-center-row">
              <div className="account-center-row-copy">
                <span className="skeleton-block account-profile-skeleton-row-title" />
              </div>
              <span className="skeleton-block account-profile-skeleton-action" />
            </div>
            <div className="account-center-row">
              <div className="account-center-row-copy">
                <span className="skeleton-block account-profile-skeleton-row-title" />
              </div>
              <span className="skeleton-block account-profile-skeleton-action" />
            </div>
          </section>
        </div>
      </div>
      <span className="visually-hidden" role="status">
        正在加载个人信息
      </span>
    </div>
  );
}

export function AccountProfileRecentWorkSkeleton(): ReactElement {
  return (
    <div
      className="account-center-session-list account-profile-skeleton-session-list"
      aria-hidden="true"
    >
      {[0, 1, 2].map((row) => (
        <div className="account-center-session account-profile-skeleton-session" key={row}>
          <span className="account-center-session-copy">
            <span className="skeleton-block account-profile-skeleton-session-title" />
            <span className="skeleton-block account-profile-skeleton-session-date" />
          </span>
          <span className="skeleton-block account-profile-skeleton-chevron" />
        </div>
      ))}
    </div>
  );
}

export function AccountProfileUsageSkeleton(): ReactElement {
  return (
    <div className="account-profile-usage-skeleton" aria-hidden="true">
      <div className="account-center-usage-summary">
        {[0, 1, 2].map((metric) => (
          <div className="account-center-usage-metric" key={metric}>
            <span className="skeleton-block account-profile-skeleton-metric-value" />
            <span className="skeleton-block account-profile-skeleton-metric-label" />
          </div>
        ))}
      </div>
      <div className="account-center-activity">
        <div className="account-center-activity-heading">
          <span className="skeleton-block account-profile-skeleton-activity-title" />
          <span className="skeleton-block account-profile-skeleton-activity-legend" />
        </div>
        <div className="account-profile-skeleton-activity-grid">
          {Array.from({ length: 7 * 53 }, (_, cell) => (
            <span className="skeleton-block" key={cell} />
          ))}
        </div>
      </div>
    </div>
  );
}

export function AccountArchivePageSkeleton(): ReactElement {
  return (
    <div
      className="archive-page account-archive-host account-archive-page-skeleton"
      aria-hidden="true"
    >
      <AccountArchiveContentSkeleton />
    </div>
  );
}

export function AccountArchiveContentSkeleton(): ReactElement {
  return (
    <div className="account-archive-content-skeleton">
      <header className="archive-heading">
        <span className="skeleton-block account-archive-skeleton-title" />
        <span className="skeleton-block account-archive-skeleton-bulk" />
      </header>
      <div className="archive-tabs">
        <span className="skeleton-block account-archive-skeleton-tab is-selected" />
        <span className="skeleton-block account-archive-skeleton-tab" />
      </div>
      <div className="archive-toolbar">
        <span className="archive-search account-archive-skeleton-search">
          <span className="skeleton-block account-archive-skeleton-search-line" />
        </span>
        <span className="account-archive-skeleton-filter">
          <span className="skeleton-block account-archive-skeleton-filter-line" />
        </span>
      </div>
      <ArchiveResultsSkeleton />
      <span className="visually-hidden" role="status">
        正在加载归档记录
      </span>
    </div>
  );
}

export function ArchiveResultsSkeleton(): ReactElement {
  return (
    <div className="account-archive-results-skeleton" aria-hidden="true">
      <section className="archive-group">
        <header>
          <div>
            <span className="skeleton-block account-archive-skeleton-folder" />
            <span className="skeleton-block account-archive-skeleton-group-title" />
          </div>
          <span className="skeleton-block account-archive-skeleton-count" />
        </header>
        <div className="archive-list">
          {[0, 1, 2].map((row) => (
            <div className="archive-row" key={row}>
              <div className="archive-row-copy">
                <span className="skeleton-block account-archive-skeleton-row-title" />
                <span className="skeleton-block account-archive-skeleton-row-date" />
              </div>
              <div className="archive-row-actions">
                <span className="skeleton-block account-archive-skeleton-row-action" />
                <span className="skeleton-block account-archive-skeleton-row-icon" />
              </div>
            </div>
          ))}
        </div>
      </section>
    </div>
  );
}

export function ArchiveHistorySkeleton(): ReactElement {
  return (
    <div className="account-archive-history-skeleton" aria-hidden="true">
      {[0, 1].map((message) => (
        <article className="archive-message archive-message--assistant" key={message}>
          <span className="skeleton-block account-archive-history-author" />
          <span className="skeleton-block account-archive-history-line" />
          <span className="skeleton-block account-archive-history-line is-short" />
          <span className="skeleton-block account-archive-history-paragraph" />
        </article>
      ))}
    </div>
  );
}

export function AccountAppearanceSkeleton(): ReactElement {
  return (
    <div className="account-appearance-screen account-appearance-skeleton" aria-hidden="true">
      <section className="detail-panel account-appearance-panel">
        <div className="caelush-appearance">
          <fieldset className="caelush-appearance__fieldset">
            <legend className="caelush-appearance__title">
              <span className="skeleton-block account-appearance-skeleton-title" />
            </legend>
            <span className="skeleton-block account-appearance-skeleton-description" />
            <div className="caelush-appearance__options">
              {[0, 1, 2].map((option) => (
                <div className="caelush-appearance__option" key={option}>
                  <div className="caelush-appearance__preview">
                    <span className="caelush-appearance__preview-sidebar skeleton-block" />
                    <span className="caelush-appearance__preview-content">
                      <span className="caelush-appearance__preview-line skeleton-block" />
                      <span className="caelush-appearance__preview-input skeleton-block" />
                    </span>
                  </div>
                  <span className="skeleton-block account-appearance-skeleton-label" />
                </div>
              ))}
            </div>
          </fieldset>
        </div>
      </section>
    </div>
  );
}
