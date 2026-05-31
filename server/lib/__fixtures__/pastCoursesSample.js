// Synthetic sample of GET /courses/mycourses/past, matching the verified
// structure: an <h3> grading-period header precedes each group of
// li.course-item#course-{id} (→ .course-title, .course-code,
// div.section-item#section-{sectionId} → a[href="/course/{sectionId}"]).
// 3 courses / 4 sections across 3 term headers: a normal semester header, a
// year-only header, and an abbreviated header. NOT real course data.
export const PAST_COURSES_HTML = `
<div class="my-courses">
  <h3>Semester 1: 08/14/2025 - 01/11/2026 · 8/14/25 - 1/11/26</h3>
  <ul class="my-courses-list">
    <li class="course-item list-item" id="course-1001">
      <span class="course-title">Digital Design 9</span>
      <span class="course-code">DSGN9</span>
      <div class="section-item" id="section-7001">
        <a href="/course/7001">Section 2(A-B)</a>
      </div>
    </li>
  </ul>
  <h3>2024-2025: 08/13/24 - 06/15/25 · 8/13/24 - 6/15/25</h3>
  <ul class="my-courses-list">
    <li class="course-item list-item" id="course-1002">
      <span class="course-title">Game Development 10</span>
      <span class="course-code">GAME10</span>
      <div class="section-item" id="section-7002">
        <a href="/course/7002">Section 8(A-B)</a>
      </div>
      <div class="section-item" id="section-7003">
        <a href="/course/7003">Section 9(C-D)</a>
      </div>
    </li>
  </ul>
  <h3>22-23 YR · 8/07/22 - 6/14/23</h3>
  <ul class="my-courses-list">
    <li class="course-item list-item" id="course-1003">
      <span class="course-title">MASTER Art, Design &amp; Technology</span>
      <span class="course-code"></span>
      <div class="section-item" id="section-7004">
        <a href="/course/7004">Master Section</a>
      </div>
    </li>
  </ul>
</div>
`;
