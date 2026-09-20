cmake_minimum_required(VERSION 3.16)

# 项目名称和版本
project(test VERSION 1.0 LANGUAGES CXX)

# 设置C++标准
set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED True)
# 生成编译命令文件
set(CMAKE_EXPORT_COMPILE_COMMANDS 1)

# 收集源文件
aux_source_directory(. SOURCE_DIR)
# 添加可执行文件
add_executable(${PROJECT_NAME} ${SOURCE_DIR})

# 添加头文件目录
target_include_directories(${PROJECT_NAME} PUBLIC ${CMAKE_SOURCE_DIR}/include)

# 添加库文件查找目录
target_link_directories(${PROJECT_NAME} PUBLIC ${CMAKE_SOURCE_DIR}/lib)
# 添加库文件
target_link_libraries(${PROJECT_NAME} pthread)

target_precompile_headers(${PROJECT_NAME} PUBLIC ${CMAKE_SOURCE_DIR}/include/pch.h)

# 安装规则 默认安装到bin目录
install(TARGETS ${PROJECT_NAME})
