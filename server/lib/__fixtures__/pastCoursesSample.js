// Synthetic sample of GET /courses/mycourses/past, matching the verified
// structure (li.course-item#course-{id} → .course-title, .course-code,
// div.section-item#section-{sectionId} → a[href="/course/{sectionId}"]).
// 3 courses / 4 sections: a single-section course, a 2-section course, and a
// no-course-code (MASTER-style) course. NOT real course data.
export const PAST_COURSES_HTML = `
<ul class="my-courses-list">
  <li class="course-item list-item" id="course-1001">
    <span class="course-title">Digital Design 9</span>
    <span class="course-code">DSGN9</span>
    <div class="section-item" id="section-7001">
      <a href="/course/7001">Section 2(A-B)</a>
    </div>
  </li>
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
  <li class="course-item list-item" id="course-1003">
    <span class="course-title">MASTER Art, Design &amp; Technology</span>
    <span class="course-code"></span>
    <div class="section-item" id="section-7004">
      <a href="/course/7004">Master Section</a>
    </div>
  </li>
</ul>
`;
