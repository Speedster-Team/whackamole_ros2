cmake_minimum_required(VERSION 3.8)
project(whackmole_server)

if(CMAKE_COMPILER_IS_GNUCXX OR CMAKE_CXX_COMPILER_ID MATCHES "Clang")
  add_compile_options(-Wall -Wextra -Wpedantic)
endif()

find_package(ament_cmake REQUIRED)
find_package(rclcpp REQUIRED)
find_package(geometry_msgs REQUIRED)
find_package(std_msgs REQUIRED)
find_package(Boost REQUIRED COMPONENTS system)
find_package(nlohmann_json REQUIRED)

add_executable(whackmole_node src/whackmole.cpp)

target_compile_features(whackmole_node PUBLIC cxx_std_23)

target_link_libraries(whackmole_node PUBLIC
  rclcpp::rclcpp
  ${geometry_msgs_TARGETS}
  ${std_msgs_TARGETS}
  Boost::system
  nlohmann_json::nlohmann_json
)

install(TARGETS whackmole_node
  DESTINATION lib/${PROJECT_NAME}
)

install(DIRECTORY launch
  DESTINATION share/${PROJECT_NAME}
)

install(DIRECTORY webapp
  DESTINATION share/${PROJECT_NAME}
  PATTERN "node_modules" EXCLUDE
  PATTERN ".next" EXCLUDE
)

ament_package()
