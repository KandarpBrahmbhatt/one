import School from "../models/school.model.js";
import mongoose from "mongoose";
import Branch from "../models/branch.model.js";
import StudentStandard from "../models/studentStandard.model.js";
import Result from "../models/result.model.js";
import redis from "../config/redis.js";
import schoolModel from "../models/school.model.js";
import Student from "../models/student.model.js";

// pdf gernate karava mae librery use kareli 6e.
import PDFDocument from 'pdfkit';

const createCacheKey = (name, params = {}) => {
    const query = new URLSearchParams();

    Object.entries(params)
        .filter(([, value]) => value !== undefined && value !== null && value !== "")
        .sort(([a], [b]) => a.localeCompare(b))
        .forEach(([key, value]) => query.append(key, String(value)));

    const queryString = query.toString();
    return queryString ? `${name}:${queryString}` : name;
};

const getCachedData = async (cacheKey) => {
    if (!redis.isEnabled()) {
        console.log("Cache skipped: Redis disabled");
        return null;
    }

    if (!redis.isReady()) {
        console.log("Cache skipped: Redis not connected");
        return null;
    }

    const cached = await redis.get(cacheKey);
    if (!cached) {
        console.log("Cache miss");
        return null;
    }

    console.log("Cache hit");
    return JSON.parse(cached);
};

const setCachedData = async (cacheKey, data) => {
    if (!redis.isEnabled() || !redis.isReady()) return;
    await redis.set(cacheKey, JSON.stringify(data), "EX", 60 * 5);
};

export const getSchoolListing = async (req, res) => {
    try {
        const cacheKey = createCacheKey("getSchoolListing")
        const cached = await getCachedData(cacheKey)
        if (cached) {
            return res.status(200).json({ source: "redis", ...cached })
        }

        const data = await School.aggregate([

            //  join branches
            {
                $lookup: {
                    from: "branches",
                    localField: "_id",
                    foreignField: "schoolId",
                    as: "branches"
                }
            },

            // join student standard
            {
                $lookup: {
                    from: "studentstandards",
                    localField: "_id",
                    foreignField: "schoolId",
                    as: "students"
                }
            },

            // 3. unwind students
            {
                $unwind: {
                    path: "$students",
                    preserveNullAndEmptyArrays: true
                }
            },

            // 4. GROUP BY SCHOOL + STANDARD
            {
                $group: {
                    _id: {
                        schoolId: "$_id",
                        schoolName: "$name",
                        standard: "$students.standard"
                    },
                    branchCount: { $first: { $size: "$branches" } },
                    totalStudents: { $sum: 1 }
                }
            },

            // 5.group again by school
            {
                $group: {
                    _id: {
                        schoolId: "$_id.schoolId",
                        schoolName: "$_id.schoolName"
                    },
                    branchCount: { $first: "$branchCount" },
                    standards: {
                        $push: {
                            standard: "$_id.standard",
                            totalStudents: "$totalStudents"
                        }
                    }
                }
            },

            // 6. formate
            {
                $project: {
                    _id: 0,
                    schoolName: "$_id.schoolName",
                    branchCount: 1,
                    standards: 1
                }
            }

        ]);

        const total = await schoolModel.countDocuments()
        const results = {
            data,
            total
        }
        await setCachedData(cacheKey, results)
        return res.status(200).json({ message: "gettingSchoolisting is Successfully", ...results })
        // res.json(data);
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: err.message });
    }
};

export const getBranchWiseData = async (req, res) => {
    try {
        const { schoolName } = req.query;

        const cacheKey = createCacheKey("getBranchWiseData", { schoolName })
        const cached = await getCachedData(cacheKey)
        if (cached) {
            return res.status(200).json({ source: "redis", ...cached })
        }

        const data = await Branch.aggregate([
            // Join School collection
            {
                $lookup: {
                    from: "schools",
                    localField: "schoolId",
                    foreignField: "_id",
                    as: "school"
                }
            },
            { $unwind: "$school" },

            // Filter by schoolName
            ...(schoolName
                ? [{
                    $match: {
                        "school.name": schoolName
                    }
                }]
                : []),

            //  Join StudentStandard
            {
                $lookup: {
                    from: "studentstandards",
                    let: { branchId: "$_id" },
                    pipeline: [
                        {
                            $match: {
                                $expr: {
                                    $eq: ["$branchId", "$$branchId"]
                                }
                            }
                        },
                        {
                            $group: {
                                _id: "$standard",
                                totalStudents: { $sum: 1 }
                            }
                        },
                        {
                            $sort: { _id: 1 } // sort classes 1 → 12
                        }
                    ],
                    as: "classStats"
                }
            },

            // Format output
            {
                $project: {
                    _id: 0,
                    branchId: "$_id",
                    branchName: "$name",
                    schoolName: "$school.name",
                    classStats: {
                        $map: {
                            input: "$classStats",
                            as: "c",
                            in: {
                                standard: "$$c._id",
                                totalStudents: "$$c.totalStudents"
                            }
                        }
                    }
                }
            }
        ]);

        const total = await Branch.countDocuments();

        const results = {
            total,
            data
        }

        await setCachedData(cacheKey, results)

        return res.status(200).json({ message: "getBranchWiseData successfully", source: "DataBase", ...results })
        // res.json({
        //     success: true,
        //     totalBranches: data.length,
        //     data
        // });

    } catch (error) {
        console.error("Branch Stats Error:", error);
        res.status(500).json({
            success: false,
            message: "Server Error"
        });
    }
};


// export const getStudentsWithMarks = async (req, res) => {
//   try {
//     const { schoolName, branchName, standard } = req.query;

//     let page = parseInt(req.query.page) || 1;
//     let limit = parseInt(req.query.limit) || 10;

//     const skip = (page - 1) * limit;

//     const pipeline = [
//       // 1. LOOKUP STUDENT
//       {
//         $lookup: {
//           from: "students",
//           localField: "studentId",
//           foreignField: "_id",
//           as: "student"
//         }
//       },
//       {
//         $addFields: {
//           student: { $arrayElemAt: ["$student", 0] }
//         }
//       },

//       // 2. LOOKUP BRANCH
//       {
//         $lookup: {
//           from: "branches",
//           localField: "branchId",
//           foreignField: "_id",
//           as: "branch"
//         }
//       },
//       {
//         $addFields: {
//           branch: { $arrayElemAt: ["$branch", 0] }
//         }
//       },

//       // 3. LOOKUP SCHOOL
//       {
//         $lookup: {
//           from: "schools",
//           localField: "student.schoolId",
//           foreignField: "_id",
//           as: "school"
//         }
//       },
//       {
//         $addFields: {
//           school: { $arrayElemAt: ["$school", 0] }
//         }
//       },

//       // 4. FILTER
//       {
//         $match: {
//           ...(schoolName && {
//             "school.name": { $regex: schoolName, $options: "i" }
//           }),
//           ...(branchName && {
//             "branch.name": { $regex: branchName, $options: "i" }
//           }),
//           ...(standard && {
//             standard: Number(standard)
//           })
//         }
//       },

//       // 5. PROJECT
//       {
//         $project: {
//           _id: 0,
//           studentName: "$student.name",
//           marks: 1,
//           branch: "$branch.name",
//           school: "$school.name",
//           class: { $concat: ["Class ", { $toString: "$standard" }] }
//         }
//       },

//       // 6. PAGINATION (IMPORTANT)
//       {
//         $skip: skip
//       },
//       {
//         $limit: limit
//       }
//     ];

//     const data = await Result.aggregate(pipeline);

//     res.json({
//       success: true,
//       page,
//       limit,
//       // count: data.length,
//       data
//     });

//   } catch (err) {
//     console.log(err);
//     res.status(500).json({
//       success: false,
//       message: "Error",
//       error: err.message
//     });
//   }
// };



export const getStudentsWithMarks = async (req, res) => {
    try {
        const { schoolName, branchName, standard, studentName } = req.query;
        const page = parseInt(req.query.page) || 1
        const limit = parseInt(req.query.limit) || 10

        const skip = (page - 1) * limit;
        const cacheKey = createCacheKey("getStudentsWithMarks", {
            branchName,
            limit,
            page,
            schoolName,
            standard,
            studentName
        });
        const cached = await getCachedData(cacheKey)


        if (cached) {
            return res.status(200).json({ source: "redis", ...cached })
        }

        const data = await Result.aggregate([

            // student
            {
                $lookup: {
                    from: "students",
                    localField: "studentId",
                    foreignField: "_id",
                    as: "student"
                }
            },
            { $unwind: "$student" },

            // branch
            {
                $lookup: {
                    from: "branches",
                    localField: "student.branchId",
                    foreignField: "_id",
                    as: "branch"
                }
            },
            { $unwind: "$branch" },

            // school
            {
                $lookup: {
                    from: "schools",
                    localField: "student.schoolId",
                    foreignField: "_id",
                    as: "school"
                }
            },
            { $unwind: "$school" },

            // filters
            {

                $match: {
                    ...(schoolName && {
                        "school.name": { $regex: schoolName, $options: "i" }
                    }),
                    ...(branchName && {
                        "branch.name": { $regex: branchName, $options: "i" }
                    }),
                    ...(standard && { standard: Number(standard) }),

                    // PDF MATE AND UPER STUDENT NAME PASS KAREL 6E QUERY MA
                    ...(studentName && {
                        "student.name": { $regex: studentName, $options: "i" }
                    })
                }
            },

            {
                $group: {
                    _id: "$studentId",
                    studentName: { $first: "$student.name" },
                    class: { $first: "$standard" },
                    branch: { $first: "$branch.name" },
                    school: { $first: "$school.name" },

                    subjects: {
                        $push: {
                            subject: "$subject",
                            marks: "$marks"
                        }
                    },

                    totalMarks: { $sum: "$marks" }
                }
            },

            {
                $project: {
                    _id: 0,
                    studentId: "$_id",
                    studentName: 1,
                    class: { $concat: ["Class ", { $toString: "$class" }] },
                    branch: 1,
                    school: 1,
                    subjects: 1,
                    totalMarks: 1
                }
            },

            {
                $skip: skip
            },
            {
                $limit: limit
            },
            // { $limit: 100 }

        ]);


        const total = await Result.countDocuments();

        const results = {
            total,
            data,
            page,
            limit,
            skip,
        }

        await setCachedData(cacheKey, results)

        res.json({ success: true, count: data.length, source: "database", ...results });

    } catch (err) {
        res.status(500).json({ error: err.message });
    }
};


// export const singleStudent = async (req, resp) => {
//     try {
//         const { id } = req.params;
//         console.log(req.params)
//         const student = await Student.findById(id)
//         console.log(student)
//         resp.status(200).json({ message: "getting singleStudent suceessfully", student })

//     } catch (error) {
//         console.log(error)
//         resp.status(200).json({ message: "gettinf singleStudent Error", message: error.message })
//     }
// }


export const downloadStudentPDF = async (req, res) => {
    try {
        const { id } = req.params;

        if (!mongoose.Types.ObjectId.isValid(id)) {
            return res.status(400).send("Invalid student id");
        }

        const [studentReport] = await Result.aggregate([
            {
                $match: {
                    studentId: new mongoose.Types.ObjectId(id)
                }
            },
            {
                $lookup: {
                    from: "students",
                    localField: "studentId",
                    foreignField: "_id",
                    as: "student"
                }
            },
            { $unwind: "$student" },
            {
                $lookup: {
                    from: "branches",
                    localField: "student.branchId",
                    foreignField: "_id",
                    as: "branch"
                }
            },
            { $unwind: "$branch" },
            {
                $lookup: {
                    from: "schools",
                    localField: "student.schoolId",
                    foreignField: "_id",
                    as: "school"
                }
            },
            { $unwind: "$school" },
            {
                $group: {
                    _id: "$studentId",
                    studentName: { $first: "$student.name" },
                    school: { $first: "$school.name" },
                    branch: { $first: "$branch.name" },
                    standard: { $first: "$standard" },
                    subjects: {
                        $push: {
                            subject: "$subject",
                            marks: "$marks"
                        }
                    },
                    totalMarks: { $sum: "$marks" }
                }
            }
        ]);

        if (!studentReport) {
            return res.status(404).send("Student result not found");
        }

        const fileName = `${studentReport.studentName || "Student"}_Report.pdf`.replace(/[^\w.-]/g, "_");
        const doc = new PDFDocument({ margin: 50 });

        res.setHeader('Content-Type', 'application/pdf');
        res.setHeader('Content-Disposition', `attachment; filename="${fileName}"`);
        doc.pipe(res);

        doc
            .font('Helvetica-Bold')
            .fontSize(22)
            .text('Student Report Card', { align: 'center' });

        doc
            .moveDown(0.4)
            .font('Helvetica')
            .fontSize(10)
            .fillColor('#666666')
            .text(`Generated on: ${new Date().toLocaleDateString('en-IN')}`, { align: 'center' });

        doc
            .moveDown(1.5)
            .fillColor('#000000')
            .font('Helvetica-Bold')
            .fontSize(14)
            .text('Student Information');

        doc.moveDown(0.7);
        doc.font('Helvetica').fontSize(12);
        doc.text(`Name: ${studentReport.studentName}`);
        doc.text(`School: ${studentReport.school}`);
        doc.text(`Branch: ${studentReport.branch}`);
        doc.text(`Class: Class ${studentReport.standard}`);

        doc
            .moveDown(1.5)
            .font('Helvetica-Bold')
            .fontSize(14)
            .text('Subject Wise Marks');

        doc.moveDown();

        const tableTop = doc.y;
        const subjectX = 70;
        const marksX = 400;
        const rowHeight = 26;
        let y = tableTop;

        doc
            .font('Helvetica-Bold')
            .fontSize(12)
            .rect(60, y - 6, 470, rowHeight)
            .fillAndStroke('#eeeeee', '#cccccc')
            .fillColor('#000000')
            .text('Subject', subjectX, y)
            .text('Marks', marksX, y);

        y += rowHeight;

        studentReport.subjects.forEach((sub) => {
            doc
                .font('Helvetica')
                .rect(60, y - 6, 470, rowHeight)
                .stroke('#dddddd')
                .text(sub.subject, subjectX, y)
                .text(String(sub.marks), marksX, y);

            y += rowHeight;
        });

        doc
            .font('Helvetica-Bold')
            .rect(60, y - 6, 470, rowHeight)
            .fillAndStroke('#f7f7f7', '#cccccc')
            .fillColor('#000000')
            .text('Total Marks', subjectX, y)
            .text(String(studentReport.totalMarks), marksX, y);

        doc.end();
    } catch (error) {
        console.log("error", error)
        res.status(500).json({ message: "downloadStudenPDF error", error: error.message });
    }
};
